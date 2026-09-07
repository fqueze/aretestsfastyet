/**
 * Framing parity: does each command's default view answer the page's question?
 *
 * `docs/PARITY.md` §1 counts six user-reported CLI defects and finds that
 * **four of the six produced correct numbers**. The sort key was executions vs
 * job runs — same set, wrong order. `issues` listed individual tests while
 * `issues.html` leads with Bugzilla components ranked by issue count — right
 * numbers, wrong question. `--coverage` printed 453 never-scheduled configs —
 * correct data, useless framing. A harness that diffs values alone catches a
 * third of what has actually gone wrong here.
 *
 * So this file asserts the third class §1 names and §5 specifies: **framing**.
 * For each command with a corresponding dashboard page, what one row is, how
 * rows are grouped, what key they are ranked on and in which direction, what
 * time window is covered, what is filtered in or out, and which harness is
 * read — asserted against the CLI, and stated side by side with what the page
 * does.
 *
 * ## Why both sides are recorded, and what a divergence means
 *
 * Every entry carries a `page` block and a `cli` block. The point is **not** to
 * freeze current CLI behaviour: a table that only restated the CLI would agree
 * with any bug the CLI already has, which is precisely how `issues` shipped a
 * flat test list through a green suite. Recording the page separately is what
 * makes "the CLI answers a different question" a thing the file can express.
 *
 * A field where the two differ must be listed in that entry's `divergences`,
 * with a reason. An undeclared divergence fails. A declared divergence whose
 * two sides have stopped differing also fails — otherwise the allow-list
 * becomes where regressions hide, which is the discipline `PARITY.md` §4 sets
 * for the page-vs-page comparison and §5 reuses here.
 *
 * ## What the assertions run against
 *
 * Real command output, through `run()` with the checked-in fixtures, not the
 * constants the commands read. An assertion that imports `DEFAULT_TYPES` and
 * checks the CLI uses `DEFAULT_TYPES` is worth nothing — it passes whatever the
 * constant says. So the expectations below are literals, and they are compared
 * against parsed `--json` from an actual invocation.
 *
 * Two fields cannot be reached that way and are marked `assertedFrom:
 * 'source'`, with the reason on the entry: they name a behaviour that no
 * fixture exercises. They are still in the table, because the table's other job
 * is to be the written-down acceptance criteria for the migrations `PARITY.md`
 * §6 sequences after this.
 *
 * ## Out of scope, deliberately
 *
 * `guide`, `dates`, `cache` and the hang mode of `crash` have no page
 * (`PARITY.md` §7). `UNCOVERED_COMMANDS` names them so "not in the table" is a
 * recorded decision rather than an oversight, and a new command that lands
 * without a framing entry fails the completeness check at the bottom.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type DataFileName, type DataSource, DataFileNotFoundError } from '../lib/sources/source.ts';
import type { TreeherderClient, TreeherderJob } from '../lib/sources/treeherder.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

// =========================================================================
// The table
// =========================================================================

/** One side's framing — the page's or the CLI's. */
interface Framing {
    /** What one row of the default view represents. */
    rowUnit: string;
    /** The default grouping, or `null` where the view is not grouped. */
    grouping: string | null;
    /**
     * The key rows are ranked on — the field, not the column label.
     *
     * The distinction is the point: the sort-key bug ranked on
     * `instances.length` where the label said the same thing the other side's
     * label said, and the two produced the same set in a different order.
     */
    sortKey: string | null;
    sortDirection: 'asc' | 'desc' | null;
    /** The default time window, in the terms the side states it. */
    window: string;
    /** What the default view includes or excludes. */
    filters: string;
    /**
     * What data the side **reads**, and what control widens it.
     *
     * Separate from `filters`, and the separation is the lesson: `filters` is
     * about rows, this is about the set the rows are computed from. Both sides
     * of `try` once said "test jobs only, non-test jobs opt-in" and both
     * strings were true — but the page's opt-in added successful test jobs'
     * profiles to what was fetched, while the CLI's opt-in only un-hid rows
     * printed from data it had already read. Two controls on two different
     * axes, sharing a name, with matching prose in the one field that could
     * have noticed. A view that never reads more than one published file says
     * so here; a view with a control that fetches more names it.
     */
    universe: string;
    /** Which harness's data the default view reads. */
    harness: string;
}

/** A field where the two sides deliberately differ. */
interface Divergence {
    field: keyof Framing;
    /** Why the CLI does something else, or why the difference is unresolved. */
    reason: string;
}

/** One command's entry. */
interface FramingEntry {
    command: string;
    /** The dashboard page this command corresponds to. */
    pageFile: string;
    /**
     * Where each page fact was read off, as `file:line`.
     *
     * Cited per field rather than per entry so a future reader can tell a CLI
     * regression from the page having moved: if `sortKey` fails, this says
     * which line to go and re-read.
     */
    pageCitations: Partial<Record<keyof Framing, string>>;
    page: Framing;
    cli: Framing;
    /** Declared, reasoned exceptions. Anything else that differs is a failure. */
    divergences: Divergence[];
    /**
     * Fields asserted against the source rather than command output, with why.
     *
     * Every other field is checked against a real invocation. These are the
     * ones a fixture cannot reach; naming them keeps the gap visible instead of
     * letting a source-read assertion pass as a behavioural one.
     */
    sourceOnly?: Partial<Record<keyof Framing, string>>;
}

/**
 * The table.
 *
 * Page facts were read off the page source; every `pageCitations` entry is a
 * line in the current tree. CLI facts are asserted below against real output.
 */
const FRAMING: FramingEntry[] = [
    {
        command: 'issues',
        pageFile: 'issues.html',
        // The page has migrated: `site/issues.html`, built from
        // `site/issues-view.ts` and `site/issues.ts`. The citations follow it,
        // because that is now the page this command is compared against — the
        // root `issues.html` is the pre-migration copy and citing it would
        // freeze facts about a file nobody is changing any more.
        pageCitations: {
            rowUnit:
                'site/issues.ts:render (one row per component), tests only as child rows via ' +
                'testRows(); old/issues.html:1933 before the migration',
            grouping:
                'site/issues-view.ts:buildComponentRows — component, with no view control; ' +
                'old/issues.html:887-890 hard-coded the same thing',
            sortKey: 'site/issues-view.ts:INITIAL_SORT (old/issues.html:663-664 before the migration)',
            window:
                'site/issues-view.ts:isHistoricalDate — an absent `date` means the 21-day ' +
                'aggregate. This is the deliberate change: old/issues.html:3709-3712 loaded the ' +
                'date-select value, one day.',
            filters: 'site/issues.html:626-638 (four checkboxes, all `checked`)',
        },
        page: {
            rowUnit: 'Bugzilla component',
            grouping: 'component',
            sortKey: 'issueCount',
            sortDirection: 'desc',
            // Was 'single most recent day'. The migration changed it, which is
            // what closed the divergence that used to be declared here.
            window: '21-day aggregate',
            filters: 'fail, timeout, crash, skip — all four issue types',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        cli: {
            rowUnit: 'Bugzilla component',
            grouping: 'component',
            sortKey: 'issueCount',
            sortDirection: 'desc',
            window: '21-day aggregate',
            filters: 'fail, timeout, crash, skip — all four issue types',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        // Empty, and that is the point: the `window` divergence that lived here
        // was declared RESOLVED-pending-migration and said in as many words
        // that it "closes when the page migrates, not when the CLI changes".
        // `site/issues.html` now defaults to the 21-day aggregate
        // (`site/issues.ts` divergence 1), so the two sides agree and the entry
        // had to go — "a declared divergence whose sides have converged is a
        // failure" is asserted below, so leaving it would have failed the suite
        // by design rather than by accident.
        //
        // Measured on the pinned xpcshell data, which is what made 21 days the
        // right side to converge on: the aggregate ranks 133 components against
        // the single day's 87, and the two orders differ below rank 5 —
        // `Toolkit :: Add-ons Manager` is 6th over 21 days and 7th on
        // 2026-08-04. The top ten are the same ten, so this steadied the
        // ranking rather than replacing it.
        divergences: [],
    },
    {
        command: 'failures',
        pageFile: 'failures.html',
        pageCitations: {
            rowUnit: 'old/failures.html:526-676 (renderFailureRows, one row per message string)',
            sortKey: 'old/failures.html:102 (currentSort), comparator :602-612',
            window: 'old/failures.html:1105-1108 (no date in hash → historical mode)',
            filters: 'old/failures.html:213-218 (only statuses starting FAIL)',
        },
        page: {
            rowUnit: 'failure message string',
            grouping: 'message',
            sortKey: 'count',
            sortDirection: 'desc',
            window: '21 days',
            // Both sides, worded identically on purpose: the point of the
            // strings matching is that a future edit to one side has to be a
            // deliberate edit to the other. The page renders the unrecorded
            // group as the literal '(no failure message)' (`:264`); the CLI
            // carries it as a null message and labels it at render time. Same
            // population, and the assertion below checks the row exists.
            filters: 'FAIL* statuses only; the unrecorded-message group is a real row',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        cli: {
            rowUnit: 'failure message string',
            grouping: 'message',
            sortKey: 'count',
            sortDirection: 'desc',
            window: '21 days',
            filters: 'FAIL* statuses only; the unrecorded-message group is a real row',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        divergences: [],
    },
    {
        command: 'crashes',
        pageFile: 'crashes.html',
        pageCitations: {
            rowUnit: 'old/crashes.html:484-590 (one row per signature)',
            sortKey: 'old/crashes.html:120 (currentSort), comparator :529-539 over totalCount',
            window: 'old/crashes.html:994 (no date in hash → historical, 21 days)',
        },
        page: {
            rowUnit: 'crash signature',
            grouping: 'signature',
            sortKey: 'count',
            sortDirection: 'desc',
            window: '21 days',
            filters: 'CRASH statuses only',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        cli: {
            rowUnit: 'crash signature',
            grouping: 'signature',
            sortKey: 'count',
            sortDirection: 'desc',
            window: '21 days',
            filters: 'CRASH statuses only',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        divergences: [],
        // Not a divergence, and deliberately not copied: `old/crashes.html:496-498`
        // sums `pathData.tests.size` over every path a signature appears under,
        // so a test that crashed under two paths counts twice. That is a page
        // bug — the comment above it says "unique tests" and the loop does not
        // produce that. The CLI's `testCount` is a distinct-test count. Left as
        // a note rather than an allow-list entry because a `testCount` field is
        // not one of the six framing dimensions; it is a value defect, for the
        // value-parity check PARITY.md §5 specifies separately.
    },
    {
        command: 'skips',
        pageFile: 'issues.html',
        pageCitations: {
            // `skips` has no page of its own: the skip population is the
            // `filter-skips` checkbox on issues.html, one of the four that make
            // up an "issue". So the page framing recorded here is that
            // checkbox's, and the row unit is the page's — component — which is
            // where the one declared divergence comes from.
            rowUnit: 'site/issues.ts:render (components view); old/issues.html:1933 before it',
            filters: 'site/issues.html:626-638 (skips is one of four checked boxes)',
            // Follows the migrated page, like the `issues` entry above.
            window: 'site/issues-view.ts:isHistoricalDate (21-day aggregate by default)',
        },
        page: {
            rowUnit: 'Bugzilla component',
            grouping: 'component',
            sortKey: 'issueCount',
            sortDirection: 'desc',
            // Was 'single most recent day'; the migration changed the page, so
            // the window this command's page-side reports changed with it. That
            // is what removed the `window` divergence this entry used to carry.
            window: '21-day aggregate',
            filters: 'skips counted alongside fail, timeout and crash',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        cli: {
            rowUnit: 'test path',
            grouping: 'test',
            sortKey: 'skipCount',
            sortDirection: 'desc',
            window: '21-day aggregate',
            filters: 'skip-if only; run-if excluded (--include-run-if keeps them)',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        divergences: [
            {
                field: 'rowUnit',
                reason:
                    'The page has no skips view; skips are one of four issue types folded into ' +
                    'the components ranking. `fx-tests skips` is a view the page does not have, ' +
                    'so "what one row is" cannot match. Per-test is the right unit for it: the ' +
                    'question is "what is disabled and where", and a component total does not ' +
                    'name a test to re-enable.',
            },
            { field: 'grouping', reason: 'Same reason as rowUnit: no page view to match.' },
            {
                field: 'sortKey',
                reason:
                    'Ranks on skipCount because that is the only quantity the view has; the ' +
                    "page's issueCount is a union over four types and would not order a " +
                    'skips-only list.',
            },
            // The `window` divergence that used to sit here — "the same
            // unresolved 1-day-vs-21-day split as `issues`" — is gone for the
            // same reason it is gone from the `issues` entry: the page migrated
            // and now defaults to the 21-day aggregate, so both sides read the
            // same window and a declared exception would be a stale one.
            {
                field: 'filters',
                reason:
                    'The CLI excludes `run-if` skips by default and the page does not ' +
                    'distinguish them. A `run-if` means the test is scoped to another platform, ' +
                    'so it not running here is the annotation working rather than work someone ' +
                    'owes. Measured asymmetry (`FORMATS.md`): the 21-day aggregate already ' +
                    'dropped run-if upstream, so on the file this command reads the flag ' +
                    'changes nothing — the output says so rather than reporting "excluded 0".',
            },
        ],
    },
    {
        command: 'flaky',
        pageFile: 'flaky.html',
        pageCitations: {
            rowUnit:
                'site/flaky-view.ts:folderRows — the tree\'s rows are folders, with test files ' +
                'as child rows when one is expanded',
            grouping:
                'site/flaky-view.ts:DEFAULT_TABLE_MODE = \'tree\'; the flat list is the other ' +
                'mode (site/flaky.ts:1211, "Every folder ranked by its own flaky tests — ' +
                'burndown candidates")',
            sortKey: 'site/flaky-view.ts:INITIAL_SORT = { field: \'flaky\', ascending: false }',
            window:
                'site/flaky.ts:1375 (tableAllDays = series.days.length > 1) — the table ' +
                'classifies over the whole window; site/flaky-view.ts:AVERAGE_WINDOW = 7 is what ' +
                'the headline tiles average',
            filters:
                'site/flaky.ts:146 (minWindowFailures = DEFAULT_MIN_WINDOW_FAILURES); ' +
                'lib/query/flakiness.ts documents run-if exclusion and fail/timeout/crash',
        },
        page: {
            rowUnit: 'directory',
            grouping: 'tree — subtree roll-up, drillable',
            sortKey: 'flaky',
            sortDirection: 'desc',
            window: '21-day aggregate, classified over the whole window',
            filters:
                'fail, timeout or crash counts as flaky; run-if skips excluded; noise filter at 1',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        cli: {
            rowUnit: 'directory',
            grouping: 'flat list — the folder’s own tests, excluding subfolders',
            sortKey: 'selfFlaky',
            sortDirection: 'desc',
            window: '7-day average of per-day classifications',
            filters:
                'fail, timeout or crash counts as flaky; run-if skips excluded; noise filter at 1',
            universe: 'one `xpcshell-issues.json`; no control fetches a second file',
            harness: 'xpcshell',
        },
        divergences: [
            {
                field: 'grouping',
                reason:
                    'The page opens on the tree because a tree is drillable in a browser and a ' +
                    'terminal cannot be drilled. The command exists to answer "which folder do I ' +
                    'book a session on", and the roll-up cannot: `toolkit` tops the tree by ' +
                    'virtue of containing everything. So the CLI leads with the page\'s other ' +
                    'mode — the flat list, which site/flaky.ts:1211 itself labels "burndown ' +
                    'candidates" — and `--group-by folder` is the roll-up. Both views exist on ' +
                    'both sides; they differ only in which is the default.',
            },
            {
                field: 'sortKey',
                reason:
                    'Same direction and the same idea of "worst", over a different population, ' +
                    'and the difference follows the grouping divergence rather than being a ' +
                    'separate choice: the tree ranks on the subtree total (`flaky`) and the flat ' +
                    'list on the folder\'s own tests (`selfFlaky`), which is what ' +
                    'site/flaky-view.ts:listRows does for the same view. Measured on the pinned ' +
                    'window, `toolkit` has 1,420 flaky in its subtree and none of its own.',
            },
            {
                field: 'window',
                reason:
                    'Both of the page\'s two readings are wrong for a ranking, in opposite ' +
                    'directions, so the CLI takes a third that the page also uses. The page\'s ' +
                    'TABLE classifies over all 21 days, where "failed at least once" is ~84% of ' +
                    'tests tree-wide and the top folders read 75-99% — a fact about the ' +
                    'denominator that ranks nothing (lib/query/flakiness.ts, and the page says ' +
                    'so itself). One day, the obvious fix, is partly a fact about the weekday: ' +
                    'weekend push volume is 2.6x lower, and on the pinned window ' +
                    '`netwerk/test/unit` reads 137 flaky on a Tuesday and 76 on a Sunday. So the ' +
                    'CLI averages per-day verdicts over 7 days — a whole number of weeks, and ' +
                    'the same 7 the page\'s headline tiles average ' +
                    '(site/flaky-view.ts:AVERAGE_WINDOW), so the tiles and this ranking agree. ' +
                    '`--all-days` and `--day` reach the page\'s two readings explicitly.',
            },
        ],
    },
    {
        command: 'errors',
        pageFile: 'errors.html',
        pageCitations: {
            rowUnit: 'old/errors.html:367, :489-497 (message view groups by messageId, whose key is text + file:line)',
            grouping: 'old/errors.html:194-198 (message is the first <option>, none marked selected)',
            sortKey: 'old/errors.html:232 (currentSort), comparator :476-483',
            window: 'old/errors.html:1144-1152 ("Default: most recent single day")',
            filters: 'old/errors.html:184-190 (seven marker-kind checkboxes, all `checked`)',
        },
        page: {
            // Worth stating precisely, because the <option> label says
            // "Message" and the identity is not the message text: a messageId
            // interns (kind, text, file, line, component), so the same string
            // from two source locations is two rows.
            rowUnit: 'messageId — (kind, text, file, line, component), a source location',
            grouping: 'message',
            sortKey: 'count',
            sortDirection: 'desc',
            window: 'single most recent day',
            filters: 'all seven marker kinds',
            universe: 'one `{harness}-{date}-errors.json`; the date control swaps the file, it does not add one',
            harness: 'mochitest',
        },
        cli: {
            rowUnit: 'messageId — (kind, text, file, line, component), a source location',
            // Named `location` rather than `message` for what the page's option
            // labels "Message": the CLI also offers a `message` grouping that
            // merges source locations, so the two names had to be told apart.
            // Same identity, different label — hence the declared divergence.
            grouping: 'location',
            sortKey: 'count',
            sortDirection: 'desc',
            window: 'single most recent day with a published errors file',
            filters: 'all marker kinds the file declares',
            universe: 'one `{harness}-{date}-errors.json`; the date control swaps the file, it does not add one',
            harness: 'mochitest',
        },
        divergences: [
            {
                field: 'grouping',
                reason:
                    "Naming only, and the identity is the same. The page's `message` option " +
                    'groups by messageId, which interns the source location too (`:367`, ' +
                    '`:489-497`) — so its rows are locations despite the label. The CLI kept ' +
                    'the accurate name for that grouping and gave `message` to the coarser ' +
                    'text-only grouping the page does not offer. `rowUnit` is asserted equal ' +
                    'on both sides, which is what stops this from hiding a real difference.',
            },
            {
                field: 'filters',
                reason:
                    'Both include everything by default; they disagree on where the kind list ' +
                    'comes from. The page hardcodes seven checkboxes in its HTML ' +
                    '(`old/errors.html:184-190`), so a kind the generator adds is invisible on the ' +
                    'page until someone edits the markup — and silently excluded from the ' +
                    'ranking. The CLI reads `tables.markerNames` off the file, so a new kind is ' +
                    'counted the day it appears and `--kind` names it. Measured on the ' +
                    'fixtures: the mochitest file declares two kinds, not seven. Not worth ' +
                    '"fixing" toward the page — the page is the side that would need changing.',
            },
            {
                field: 'window',
                reason:
                    'Both are "one most recent day", and the CLI has to add "with a published ' +
                    'errors file" because the errors files exist for only about five of the 21 ' +
                    'dates `index.json` lists (`FORMATS.md`). The page picks from a ' +
                    '`date-select` populated with dates that have data; the CLI walks ' +
                    'newest-first and keeps the first file that exists. Same question, and the ' +
                    'CLI cannot assume what the page reads off a populated control.',
            },
        ],
    },
    {
        command: 'manifests',
        pageFile: 'manifests.html',
        pageCitations: {
            rowUnit: 'old/manifests.html:642-679 (one row per manifest path)',
            sortKey: 'old/manifests.html:360-361 (currentSortColumn/Direction), applied :499',
            window: 'manifests.html — a single artifact, no date control',
            filters: 'old/manifests.html:416, :441-442, :461 (an all-zero-duration pair is a skip)',
        },
        page: {
            rowUnit: 'manifest path',
            grouping: null,
            sortKey: 'median',
            sortDirection: 'desc',
            window: 'a single artifact — one day, no date control',
            filters: 'all-zero-duration pairs treated as skipped, excluded from stats',
            universe: 'one `manifests.json`; no control fetches a second file',
            harness: 'both — the file is per-manifest, not per-harness',
        },
        cli: {
            rowUnit: 'manifest path',
            grouping: null,
            sortKey: 'median',
            sortDirection: 'desc',
            window: 'a single artifact — one day, no date control',
            filters: 'all-zero-duration pairs treated as skipped, excluded from stats',
            universe: 'one `manifests.json`; no control fetches a second file',
            harness: 'both — the file is per-manifest, not per-harness',
        },
        divergences: [],
        // A page bug that is not a CLI gap, noted where it will be read: the
        // page's median is the upper middle element (`:429`,
        // `durations[Math.floor(length / 2)]`), not interpolated, so an
        // even-length sample reports the higher of the two middle values.
        //
        // An earlier version of this comment said "the CLI's `medianOf` matches
        // it deliberately". Both halves were false, and the claim was repeated
        // into a migration brief before anyone checked it: there is no
        // `medianOf` anywhere in `lib/` or `cli/`, and the CLI reaches its
        // median through `quantile` (`cli/commands/test.ts:781`), whose
        // `Math.ceil(q * n) - 1` is nearest-rank — the *lower* middle. On
        // `[10 … 100]` the page says 60 and the CLI says 50, and the two
        // disagree on 3,122 of the 6,227 manifests in the published file.
        // Declared as a divergence by `test/manifests-parity.test.ts`.
    },
    {
        command: 'summary',
        pageFile: 'index.html',
        pageCitations: {
            rowUnit: 'old/index.html:517-556 (one row per harness, per-flavor sub-rows)',
            sortKey: 'old/index.html:517-556 — none, the rows are emitted in source order',
            window: 'old/index.html:524, :534 (getRecentStats(stats, 7))',
        },
        page: {
            rowUnit: 'harness',
            grouping: 'harness',
            // Two harnesses in a fixed order is not a ranking, and recording it
            // as one would invent a key neither side has.
            sortKey: null,
            sortDirection: null,
            window: '7 days',
            filters: 'none — every job and test run in the window',
            universe: 'one `{harness}-stats.json`; no control fetches a second file',
            harness: 'both — xpcshell and mochitest',
        },
        cli: {
            rowUnit: 'harness',
            grouping: 'harness',
            sortKey: null,
            sortDirection: null,
            window: '7 days',
            filters: 'none — every job and test run in the window',
            universe: 'one `{harness}-stats.json`; no control fetches a second file',
            harness: 'both — xpcshell and mochitest',
        },
        divergences: [],
        // Note, not a divergence: `old/index.html:476` subtracts invalid jobs from
        // the Flaky Job Failures numerator and `:479` does not subtract them
        // from the denominator, so the rate can go negative when invalid jobs
        // exceed failed ones. The CLI reports `jobFailureRate` and
        // `invalidJobRate` as separate rows rather than reproducing the mixed
        // one. A page bug, and the reason the CLI does not copy the formula.
    },
    {
        command: 'test',
        pageFile: 'test.html',
        pageCitations: {
            rowUnit: 'old/test.html:2670, :2732-2806 (one row per job variant, platforms as columns)',
            grouping: 'test.html — fixed sections, no tabs',
            sortKey: 'old/test.html:2726-2731 (variant prefix by total runs desc); platform columns lexicographic at :2698',
            window: 'test.html — the chunk file window, metadata.days',
        },
        page: {
            rowUnit: 'job variant, with platforms as columns',
            grouping: null,
            sortKey: 'total runs of the variant prefix',
            sortDirection: 'desc',
            window: '21 days — the chunk file window',
            filters: 'none — every status the file records',
            universe: 'the one bucket file holding the test; no control fetches a second file',
            harness: 'inferred from the test path',
        },
        cli: {
            rowUnit: 'configuration (jobName), one per row',
            grouping: null,
            // `failRate`, not `failCount` — measured, and the two disagree on
            // the fixture: the Windows config has 4 failures in 109 runs (3.7%)
            // and the macOS one 6 in 761 (0.8%), so a count ranking puts macOS
            // first and a rate ranking puts Windows first. Rate is the right
            // one for "where is this broken": a config that runs ten times as
            // often accumulates more failures without being worse.
            // `lib/query/config-stats.ts:362`.
            sortKey: 'failRate',
            sortDirection: 'desc',
            window: '21 days — the chunk file window',
            filters: 'default view lists failing configs only; --coverage lists every config',
            universe: 'the one bucket file holding the test; no control fetches a second file',
            harness: 'inferred from the test path',
        },
        divergences: [
            {
                field: 'rowUnit',
                reason:
                    'The page renders a variant × platform matrix because it has the width for ' +
                    'one; a terminal does not, and a matrix wrapped at 80 columns is unreadable. ' +
                    'The CLI flattens to one row per configuration, which is the same ' +
                    'population — a (variant, platform) cell is a configuration — presented as ' +
                    'a list rather than a grid.',
            },
            {
                field: 'sortKey',
                reason:
                    'The page has no user-changeable sort and orders variants by total runs, ' +
                    'which is a layout choice for a matrix whose columns must line up. A list ' +
                    'ranked by run count would put the busiest config first and the broken one ' +
                    'wherever it fell; the question `fx-tests test` answers is "where is this ' +
                    'failing", so it ranks on failure *rate* ' +
                    '(`lib/query/config-stats.ts:362`). Rate rather than count for the same ' +
                    'reason: measured on the bucket fixture, the Windows config fails 4 of 109 ' +
                    'runs and macOS 6 of 761, so a count ranking reports the healthier config ' +
                    'as the worse one.',
            },
            {
                field: 'filters',
                reason:
                    'The matrix shows every cell because it is a matrix. A terminal list of ' +
                    'every configuration is hundreds of rows of zeroes, so the default is the ' +
                    'failing ones and `--coverage` is the full picture. `CLI.md` requires the ' +
                    'default view to state where the test runs at all ("Runs on N configs ' +
                    'across …"), so the narrowing cannot be mistaken for absence.',
            },
        ],
        sourceOnly: {
            window:
                'The 21-day width is a property of the published file, not of the command: the ' +
                'bucket fixture is a 21-day window and the CLI reports whatever `metadata.days` ' +
                'says. Asserting "21" against the fixture would assert the fixture. What the ' +
                'output *can* be held to is that it states the window it used, which the ' +
                'metadata assertion below does.',
        },
    },
    {
        command: 'try',
        pageFile: 'try.html',
        pageCitations: {
            rowUnit: 'old/try.html:1493-1517 (one row per test path)',
            grouping: 'old/try.html:1765-1766 (up to 3 tables, the split is data-driven)',
            sortKey: 'old/try.html:744 (currentSort), :1749 (count = a.instances.length)',
            window: 'try.html — the push; central history uses MIN_RECENT_RUNS = 100 (:2572)',
            filters: 'old/try.html:1486 (the five failure statuses), :816 (non-test jobs listed apart)',
            universe:
                'site/try.ts:944 (`fetchPassing` concatenates `successfulTestJobs`); ' +
                'old/try.html:706, :3775 ("All jobs" unchecked by default)',
        },
        page: {
            rowUnit: 'test path',
            grouping: 'perma-fail / known intermittent / new intermittent',
            // `count` is the column label; `instances.length` is the key, and
            // the two are not the same thing. Ranking on distinct job runs
            // instead produced the same set in a different order and passed
            // every test in the suite — PARITY.md §1's "order parity" row.
            // The tiebreak is part of the key, not of the direction: two rows
            // with equal counts have to come out in *some* order, and the page
            // leaves that to insertion order. Recording it here rather than in
            // `sortDirection` is what makes the declared divergence name the
            // thing that actually differs.
            sortKey: 'failing executions (instances.length), ties in insertion order',
            sortDirection: 'desc',
            window: 'the push',
            // Identical sets on both sides, verified: `old/try.html:1486` and
            // `cli/commands/try.ts:430` declare the same five failure statuses,
            // UNEXPECTED-PASS included.
            //
            // This field used to also carry "non-test jobs opt-in", which was
            // true of both sides and hid the defect the `universe` field now
            // separates out: the page's opt-in adds fetches, the CLI's added
            // rows. Non-test failures are a row question and stay here; which
            // jobs are read is not, and does not.
            filters:
                'test-job rows only, non-test job failures listed apart; FAIL, TIMEOUT, ' +
                'CRASH, ERROR and UNEXPECTED-PASS all count as failures',
            universe:
                'failed test jobs; the successful ones opt-in, which is the only way a test ' +
                'that failed then passed on retry can appear',
            harness: 'mochitest and xpcshell — whichever the push ran',
        },
        cli: {
            rowUnit: 'test path',
            grouping: 'perma-fail / known intermittent / new intermittent',
            sortKey: 'failing executions (failureCount), ties by path',
            sortDirection: 'desc',
            window: 'the push',
            filters:
                'test-job rows only, non-test job failures listed apart; FAIL, TIMEOUT, ' +
                'CRASH, ERROR and UNEXPECTED-PASS all count as failures',
            universe:
                'failed test jobs; the successful ones opt-in, which is the only way a test ' +
                'that failed then passed on retry can appear',
            harness: 'mochitest and xpcshell — whichever the push ran',
        },
        divergences: [
            {
                field: 'sortKey',
                reason:
                    'Same quantity and same direction; the CLI adds a `localeCompare` path tiebreak ' +
                    'the page does not have (`cli/commands/try.ts:1035`). The page leaves equal ' +
                    'counts in insertion order and relies on the stability of two `sort()` ' +
                    'calls, so its tie order is the order eight web workers finished parsing ' +
                    'profiles fetched 64 at a time — a network race that reshuffles between ' +
                    'reloads. A command whose output is diffed and pasted into bugs cannot be ' +
                    'non-deterministic. Declared in `PARITY.md` §5 as a difference that stays.',
            },
        ],
    },
];

/**
 * Commands with no corresponding page, per `PARITY.md` §7.
 *
 * Listed rather than omitted so the completeness check below can tell "decided
 * not to cover this" from "forgot". Each says why there is nothing to compare.
 */
const UNCOVERED_COMMANDS: Record<string, string> = {
    intermittent:
        'Reads Treeherder’s sheriff-annotation endpoints and Bugzilla, not this repository’s ' +
        'aggregates, so there is no page here to diverge from. The upstream equivalent is ' +
        'treeherder.mozilla.org/intermittent-failures/, which is not ours to keep in parity ' +
        'with — and its framing already differs deliberately: it ranks bugs tree-wide with no ' +
        'harness notion, while this command ranks a bug on its occurrences in one harness.',
    guide: 'Prose about what the data can and cannot tell you. No page, and no rows to frame.',
    dates: 'Lists which dates have published data. A provenance query, not a view of test data.',
    cache: 'Inspects the local on-disk cache. Nothing upstream to compare against.',
    task:
        'Reads one job’s own `profile_resource-usage.json`. `try.html` reads the same artifact, ' +
        'but per push and only to aggregate across configurations — it has no single-task view, ' +
        'and it is the absence of one that this command exists for. Nothing to frame either: no ' +
        'ranking beyond `try`’s failing-executions sort, no window, no filter, and the harness ' +
        'is whatever the task ran.',
    crash:
        'Reads one processed crash or hang dump. `crash-viewer.html` covers the crash mode and ' +
        'is the first migration target (`PARITY.md` §6.2); the hang mode has no page at all. ' +
        'Out of scope here: this command takes a task ID and a minidump ID and renders one ' +
        'dump, so it has no default ranking, window or filter to frame.',
};

// =========================================================================
// Harness
// =========================================================================

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixtureBytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

/** Every fixture, under the name the CLI asks for. */
const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'mochitest-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
    'xpcshell-timings/xpcshell-2026-08-03-errors.json': 'xpcshell-2026-08-03-errors.json',
    'mochitest-timings/mochitest-2026-08-03-errors.json': 'mochitest-2026-08-03-errors.json',
    'manifest-timings/manifests.json': 'manifests.json',
    'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
    'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
    'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
    'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
};

/**
 * A source over the fixtures, recording what was asked for.
 *
 * No network: `PARITY.md`'s brief and `PLAN.md` §3 step 4 both require the
 * suite to be offline, and the injected source is what makes that structural.
 * The `requested` log is what lets the harness assertions below check *which*
 * file a default read, which is the load-bearing half of "defaults to
 * mochitest".
 */
function fixtureSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixtures',
        requested,
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
            const local = FILES[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return fixtureBytes(local);
        },
    };
}

/** The xpcshell test the bucket fixture is built around. */
const TEST_PATH = 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js';

/** A Treeherder client over canned jobs, so `try` runs offline. */
function fakeTreeherder(jobs: TreeherderJob[]): TreeherderClient {
    return {
        findPush: () =>
            Promise.resolve({
                pushId: 1,
                revision: 'abcdef1234567890',
                repository: 'try',
                revisions: [],
            }),
        jobsOfPush: () => Promise.resolve(jobs),
    };
}

/**
 * A profile carrying `Test` markers, in the shape the harness emits.
 *
 * `entries` is a list of (test path, how many failing executions) — the axis
 * that matters here, because the sort key under test is *executions* and the
 * only way to tell it from a job-run count is a test that failed twice in one
 * job.
 */
function profileWithFailures(entries: { test: string; executions: number }[]): string {
    const markers: { data: Record<string, unknown>; start: number }[] = [];
    let clock = 1;
    for (const entry of entries) {
        for (let i = 0; i < entry.executions; i++) {
            markers.push({
                data: { type: 'Test', test: entry.test, status: 'FAIL', message: 'boom' },
                start: clock++,
            });
        }
    }
    return JSON.stringify({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test'],
                markers: {
                    length: markers.length,
                    name: markers.map(() => 0),
                    data: markers.map((marker) => marker.data),
                    startTime: markers.map((marker) => marker.start),
                    endTime: markers.map((marker) => marker.start + 1),
                },
            },
        ],
    });
}

/** Serves one profile per task. */
function profileFetcher(byTask: Record<string, string>): (url: string) => Promise<Uint8Array | null> {
    return (url: string) => {
        const match = /task\/([^/]+)\//.exec(url);
        const body = match === null ? undefined : byTask[match[1]!];
        return Promise.resolve(body === undefined ? null : new TextEncoder().encode(body));
    };
}

/** Runs one invocation against the fixtures. */
async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<{ code: number; stdout: string; stderr: string; requested: string[] }> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? fixtureSource();
    const code = await run({
        argv,
        streams,
        source,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return {
        code,
        stdout: streams.stdout,
        stderr: streams.stderr,
        requested: (source as DataSource & { requested?: string[] }).requested ?? [],
    };
}

function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

/** The entry for a command, or a failure naming the table. */
function entryFor(command: string): FramingEntry {
    const found = FRAMING.find((candidate) => candidate.command === command);
    assert.ok(found !== undefined, `no framing entry for "${command}" — add one to FRAMING`);
    return found;
}

/**
 * Asserts one framing field, with a message a future reader can act on.
 *
 * The message is the whole point of this helper. A bare `assert.equal` failure
 * says two strings differ; this says which command, which dimension, what the
 * table expected, and **which page line the expectation came from** — so the
 * reader can go and check whether the CLI regressed or the page moved, which
 * are opposite conclusions with opposite fixes.
 */
function assertFraming(
    command: string,
    field: keyof Framing,
    actual: unknown,
    expected: unknown
): void {
    const entry = entryFor(command);
    const citation = entry.pageCitations[field];
    const declared = entry.divergences.find((divergence) => divergence.field === field);
    const context = [
        `${command}: default ${field} changed.`,
        `  table expects: ${JSON.stringify(expected)}`,
        `  CLI produced:  ${JSON.stringify(actual)}`,
        `  ${entry.pageFile} does: ${JSON.stringify(entry.page[field])}`,
        citation === undefined
            ? `  page fact not cited for this field`
            : `  derived from ${citation}`,
        declared === undefined
            ? '  This field has no declared divergence, so the CLI is expected to match the page.'
            : `  Declared divergence: ${declared.reason}`,
        '',
        '  If the CLI changed deliberately, update FRAMING in test/framing.test.ts and say why.',
        '  If the page moved, re-read the cited line and update the page side too.',
    ].join('\n');
    assert.deepEqual(actual, expected, context);
}

// =========================================================================
// The table's own invariants
// =========================================================================

test('every field where the two sides differ is a declared divergence', () => {
    // The check that makes the table mean something. Without it a CLI that
    // quietly drifts away from its page passes, because both columns are just
    // data in this file — which is the failure mode PARITY.md §1 names: "the
    // tests verified the code against itself".
    const fields: (keyof Framing)[] = [
        'rowUnit',
        'grouping',
        'sortKey',
        'sortDirection',
        'window',
        'filters',
        'universe',
        'harness',
    ];
    for (const entry of FRAMING) {
        const declared = new Set(entry.divergences.map((divergence) => divergence.field));
        for (const field of fields) {
            const differs = entry.page[field] !== entry.cli[field];
            if (differs && !declared.has(field)) {
                assert.fail(
                    `${entry.command}: ${entry.pageFile} and the CLI disagree on ${field}, and it ` +
                        `is not declared.\n` +
                        `  page: ${JSON.stringify(entry.page[field])}\n` +
                        `  cli:  ${JSON.stringify(entry.cli[field])}\n` +
                        `  ${entry.pageCitations[field] ?? '(no citation)'}\n` +
                        '  Either bring the CLI back to the page, or add a divergences entry ' +
                        'saying why the difference is correct.'
                );
            }
        }
    }
});

test('a declared divergence whose sides have converged is a failure', () => {
    // The other half of the allow-list discipline PARITY.md §4 sets. A stale
    // exception is where a regression hides: once the two sides agree, the
    // entry stops protecting anything and starts excusing whatever drifts next.
    for (const entry of FRAMING) {
        for (const divergence of entry.divergences) {
            assert.notEqual(
                entry.cli[divergence.field],
                entry.page[divergence.field],
                `${entry.command}: the declared divergence on ${divergence.field} no longer ` +
                    `diverges — both sides say ${JSON.stringify(entry.cli[divergence.field])}. ` +
                    'Delete the entry; leaving it lets the next real difference through ' +
                    `unnoticed.\n  Its stated reason was: ${divergence.reason}`
            );
        }
    }
});

test('every divergence carries a reason, and every page fact a citation', () => {
    for (const entry of FRAMING) {
        for (const divergence of entry.divergences) {
            assert.ok(
                divergence.reason.length > 40,
                `${entry.command}/${divergence.field}: a divergence needs a reason someone can ` +
                    'evaluate, not a label'
            );
        }
        // Every field that differs must be traceable to a line someone can go
        // and re-read; that is what tells a CLI regression from a page move.
        for (const divergence of entry.divergences) {
            const cited =
                entry.pageCitations[divergence.field] !== undefined ||
                Object.keys(entry.pageCitations).length > 0;
            assert.ok(cited, `${entry.command}: no page citations at all`);
        }
        for (const [field, citation] of Object.entries(entry.pageCitations)) {
            // A citation has to name a file a reader can open. `.html` was the
            // only possibility while every page was one inline `<script>`; a
            // migrated page's decisions live in its `site/*.ts` modules, and
            // citing `site/issues.html` for a rule implemented in
            // `site/issues-view.ts` would point at the wrong file. Both forms
            // are accepted, and the check still rejects a citation that names
            // no file at all — which is what it was for.
            assert.match(
                citation,
                /\.html|site\/[\w-]+\.ts/,
                `${entry.command}/${field}: a citation must name the page file — either a ` +
                    '`.html` page or, for a migrated page, the `site/*.ts` module that ' +
                    'implements the decision'
            );
        }
    }
});

test('every implemented command is either framed or explicitly uncovered', async () => {
    // Completeness, driven off the command list rather than a copy of it: a
    // command that lands without a framing entry is exactly the case this
    // catches, and a hand-maintained list would not.
    const { COMMAND_NAMES } = await import('../cli/main.ts');
    const framed = new Set(FRAMING.map((entry) => entry.command));
    for (const name of COMMAND_NAMES) {
        const covered = framed.has(name) || name in UNCOVERED_COMMANDS;
        assert.ok(
            covered,
            `"${name}" has no framing entry and is not in UNCOVERED_COMMANDS. Either add it ` +
                'to FRAMING with the page it corresponds to, or record why it has no page ' +
                '(PARITY.md §7).'
        );
    }
    // And the other direction: a stale entry for a command that no longer
    // exists would silently stop being checked.
    for (const entry of FRAMING) {
        assert.ok(COMMAND_NAMES.includes(entry.command), `FRAMING names "${entry.command}", which is not a command`);
    }
    for (const name of Object.keys(UNCOVERED_COMMANDS)) {
        assert.ok(COMMAND_NAMES.includes(name), `UNCOVERED_COMMANDS names "${name}", which is not a command`);
    }
});

// =========================================================================
// fx-tests issues — the framing bug that motivated all of this
// =========================================================================

test('issues leads with components, not a flat test list', async () => {
    // The bug PARITY.md §1 puts in the "right numbers, wrong question" row.
    // Asserted on real output, not on the constant `runIssues` reads: an
    // assertion that imports the default and checks the default is used passes
    // whatever the default says.
    const { code, stdout } = await invoke(['issues', '--json', '--limit', '3']);
    assert.equal(code, 0);
    const result = json(stdout);

    assertFraming('issues', 'grouping', result['groupBy'], 'component');

    // Not merely the label: the rows must actually be components. A component
    // key is "Product :: Component"; a test path is not.
    const rows = result['rows'] as { key: string }[];
    assert.ok(rows.length > 0, 'the fixture must produce component rows');
    for (const row of rows) {
        assert.match(
            row.key,
            / :: /,
            `issues rows must be Bugzilla components (old/issues.html:1933), got "${row.key}" — a ` +
                'flat test list here is the exact defect PARITY.md §1 records'
        );
    }
});

test('issues ranks components on issueCount descending', async () => {
    const { stdout } = await invoke(['issues', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('issues', 'sortKey', result['sort'], 'issues');

    // The order itself, not the label. `old/issues.html:663-664` sets sortField to
    // `issueCount` and the direction to desc; a command reporting `sort:
    // "issues"` while emitting rate order would pass a label check.
    const rows = result['rows'] as { key: string; issueCount: number }[];
    assert.ok(rows.length > 1, 'need at least two rows to observe an order');
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.issueCount >= rows[i]!.issueCount,
            `issues must be ranked by issueCount descending (old/issues.html:663-664, comparator ` +
                `:2066-2081): row ${i - 1} has ${rows[i - 1]!.issueCount} and row ${i} has ` +
                `${rows[i]!.issueCount}`
        );
    }
});

test('issues counts all four issue types by default', async () => {
    const { stdout } = await invoke(['issues', '--json', '--limit', '1']);
    const types = json(stdout)['types'] as string[];
    // `old/issues.html:626-638` — four checkboxes, every one `checked`. Pinned as a
    // literal set rather than compared against DEFAULT_TYPES, which is the
    // constant the command itself reads.
    assertFraming('issues', 'filters', [...types].sort(), ['crash', 'fail', 'skip', 'timeout']);
});

test('issues reads the 21-day aggregate, and so does the migrated page', async () => {
    // This used to assert a *declared divergence*: the CLI covered 21 days and
    // `issues.html` opened on one. The migration closed it by changing the
    // page, which is the direction the old entry specified, so what is checked
    // here is now the agreement rather than the gap.
    const { stdout } = await invoke(['issues', '--json', '--limit', '1']);
    const header = json(stdout)['header'] as { dayCount: number; singleDay: boolean };
    assert.equal(
        header.singleDay,
        false,
        'fx-tests issues covers the whole window, and site/issues.html now defaults to the ' +
            'same one. If this became single-day the two sides would disagree again and the ' +
            'window divergence would have to be re-declared in FRAMING.'
    );
    assert.equal(header.dayCount, 21, 'the aggregate is 21 days');

    // The page side, read off the migrated source rather than restated. Both
    // halves matter and neither is checkable from CLI output: the page has to
    // treat an absent `date` as the 21-day view, and it has to fetch the
    // aggregate file rather than a daily one.
    //
    // Asserted against the real function, not against a copy of its rule — an
    // assertion that reimplemented `isHistoricalDate` here would pass whatever
    // the page did.
    const { isHistoricalDate, HISTORICAL_DATE } = await import('../site/issues-view.ts');
    assert.equal(
        isHistoricalDate(undefined),
        true,
        'no `date` in the hash must mean the 21-day aggregate — this is the migration\'s ' +
            'deliberate change (site/issues.ts divergence 1). old/issues.html:3709-3712 loaded the ' +
            'date-select value instead.'
    );
    assert.equal(isHistoricalDate(HISTORICAL_DATE), true);
    assert.equal(
        isHistoricalDate('2026-08-04'),
        false,
        'a named day must still select that day, or the migration removed a working control'
    );

    const source = await readFile(new URL('../site/issues.ts', import.meta.url), 'utf8');
    assert.match(
        source,
        /historicalDataFile: `\$\{harness\}-issues\.json`/,
        'the 21-day view must read the aggregate `{harness}-issues.json`, which is a different ' +
            'file with a different shape from the daily `{harness}-<date>.json`'
    );

    // And the entry must no longer declare a window divergence: the sides have
    // converged, and the invariant above ("a declared divergence whose sides
    // have converged is a failure") is what enforces that from the other end.
    const entry = entryFor('issues');
    assert.equal(
        entry.divergences.find((divergence) => divergence.field === 'window'),
        undefined,
        'the 1-day-vs-21-day split is resolved; its entry must be gone, not kept as a stale ' +
            'exception for the next real difference to hide behind'
    );
});

test('issues keeps issue-free tests in a component total, as the page does', async () => {
    // `old/issues.html:2007-2013` accumulates `runCount` for every test in the
    // component and only then gates the *display* list on `hasIssues` (`:2016`)
    // — so a component's denominator covers its whole population. A CLI that
    // summed only the failing tests would report a higher rate from the same
    // data, which is a framing difference disguised as a number.
    const { stdout } = await invoke(['issues', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as { testCount: number; totalTestCount: number }[];
    assert.ok(rows.length > 0);
    assert.ok(
        rows.some((row) => row.totalTestCount > row.testCount),
        'at least one fixture component must have clean tests, or this asserts nothing'
    );
    for (const row of rows) {
        assert.ok(
            row.totalTestCount >= row.testCount,
            'a component cannot have more tests with issues than tests'
        );
    }
});

// =========================================================================
// fx-tests failures / crashes / skips
// =========================================================================

test('failures rows are message strings ranked on count descending', async () => {
    const { stdout } = await invoke(['failures', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('failures', 'grouping', result['groupBy'], 'message');
    assertFraming('failures', 'sortKey', result['sort'], 'count');

    const rows = result['rows'] as { message: string | null; count: number }[];
    assert.ok(rows.length > 1);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.count >= rows[i]!.count,
            `failures must rank on count descending (old/failures.html:102, comparator :602-612)`
        );
    }
});

test('failures keeps the unrecorded-message row, as the page does', async () => {
    // `old/failures.html:264` renders '(no failure message)' as a real row. Dropping
    // it would silently shrink the population — and on the fixture it is the
    // largest row, so a filtered-out null would change which failure ranks
    // first.
    const { stdout } = await invoke(['failures', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as { message: string | null }[];
    assert.ok(
        rows.some((row) => row.message === null),
        'a group with no recorded message must be a row, not dropped (old/failures.html:264)'
    );
});

test('crashes rows are signatures ranked on count descending', async () => {
    const { stdout } = await invoke(['crashes', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as { signature: string | null; count: number }[];
    assert.ok(rows.length > 1);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.count >= rows[i]!.count,
            'crashes must rank on count descending (old/crashes.html:120, comparator :529-539)'
        );
    }
    // One row per signature, so no signature appears twice.
    const seen = new Set(rows.map((row) => row.signature));
    assert.equal(seen.size, rows.length, 'the row unit is the signature (old/crashes.html:484-590)');
});

test('crashes counts each test once per signature, unlike the page', async () => {
    // Not a divergence entry, because `testCount` is a value rather than one of
    // the six framing dimensions — but worth pinning here because the page is
    // the one that is wrong. `old/crashes.html:496-498` sums `pathData.tests.size`
    // across every path a signature appears under, double-counting a test that
    // crashed under two paths. The CLI's testCount is the distinct-test count,
    // so it must equal the length of the tests array.
    const { stdout } = await invoke(['crashes', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        testCount: number;
        tests: { test: string }[];
    }[];
    assert.ok(rows.length > 0);
    for (const row of rows) {
        const distinct = new Set(row.tests.map((entry) => entry.test));
        assert.equal(
            row.testCount,
            distinct.size,
            'testCount must be distinct tests; old/crashes.html:496-498 double-counts across paths ' +
                'and that page bug is deliberately not copied'
        );
    }
});

test('skips rows are tests ranked on skipCount, and exclude run-if', async () => {
    const { stdout } = await invoke(['skips', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('skips', 'grouping', result['groupBy'], 'test');
    assert.equal(
        result['includeRunIf'],
        false,
        'run-if means "scoped elsewhere", not "disabled", so it is excluded by default'
    );

    const rows = result['rows'] as { test: string; skipCount: number }[];
    assert.ok(rows.length > 1);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.skipCount >= rows[i]!.skipCount,
            'skips must rank on skipCount descending'
        );
    }
    // The row unit: a test path, not a component. This is the declared
    // divergence from issues.html's components view, asserted so that "the CLI
    // is per-test here" stays a fact rather than an assumption.
    for (const row of rows) {
        assert.doesNotMatch(
            row.test,
            / :: /,
            `skips rows are test paths, not components; got "${row.test}"`
        );
    }
});

test('skips says which run-if population it reported, rather than "excluded 0"', async () => {
    // The measured asymmetry (`FORMATS.md`): the 21-day aggregate already
    // dropped run-if upstream, so on this file the flag changes nothing.
    // Reporting "0 excluded" would say there were none rather than that the
    // generator got there first.
    const { stdout } = await invoke(['skips', '--json', '--limit', '1']);
    assert.equal(json(stdout)['runIfIsUpstreamFiltered'], true);
    const text = await invoke(['skips', '--limit', '1']);
    assert.match(text.stdout, /generator already dropped run-if skips/);
});

// =========================================================================
// fx-tests flaky
// =========================================================================

test('flaky leads with the burndown list, not the page’s tree', async () => {
    // The declared `grouping` divergence, asserted on real output. Both halves
    // matter: the label, and that the rows really are single folders rather than
    // subtree roll-ups — a container with no tests of its own must not be one.
    const { code, stdout } = await invoke(['flaky', '--json', '--limit', '0']);
    assert.equal(code, 0);
    const result = json(stdout);
    assertFraming('flaky', 'grouping', result['groupBy'], 'list');

    const rows = result['rows'] as { path: string; flaky: number; testCount: number }[];
    assert.ok(rows.length > 0, 'the fixture must produce folder rows');
    for (const row of rows) {
        assert.ok(
            row.testCount > 0,
            `${row.path} has no test files of its own, so it is not a burndown candidate — the ` +
                'flat list must exclude pure containers (lib/query/flakiness.ts:folderList)'
        );
    }

    // The page side, read off the migrated source rather than restated: the page
    // has to actually default to the tree, or this divergence is imaginary.
    const { DEFAULT_TABLE_MODE } = await import('../site/flaky-view.ts');
    assert.equal(
        DEFAULT_TABLE_MODE,
        'tree',
        'flaky.html opens on the tree; if it ever opens on the list, the grouping divergence has ' +
            'converged and its FRAMING entry must go'
    );
});

test('flaky ranks on the folder’s own flaky count, descending', async () => {
    const { stdout } = await invoke(['flaky', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as { path: string; flaky: number; subtreeFlaky: number }[];
    assert.ok(rows.length > 1, 'need at least two rows to observe an order');
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.flaky >= rows[i]!.flaky,
            `flaky must rank on the folder's own count descending: row ${i - 1} has ` +
                `${rows[i - 1]!.flaky} and row ${i} has ${rows[i]!.flaky}`
        );
    }
    // And the ranked column is `selfFlaky`, not the roll-up — which is the
    // declared `sortKey` divergence. The 10-test fixture is flat, so every one of
    // its folders is its own subtree and the two counters coincide there; the
    // distinction is instead asserted where it is visible, against the roll-up
    // view of the same data. `toolkit` has flaky tests in its subtree and none of
    // its own, so it ranks in one view and is absent from the other.
    const roll = json((await invoke(['flaky', '--json', '--limit', '0', '--group-by', 'folder'])).stdout);
    const rollRows = roll['rows'] as { path: string; flaky: number }[];
    const container = rollRows.find((row) => row.path === 'toolkit');
    assert.ok(
        container !== undefined && container.flaky > 0,
        '--group-by folder must rank a container by its subtree'
    );
    assert.ok(
        !rows.some((row) => row.path === 'toolkit'),
        'the default list must NOT rank that container, because it has no tests of its own — ' +
            'that difference is the whole reason the two views exist'
    );
});

test('flaky averages 7 days rather than taking the page’s window or one day', async () => {
    // The `window` divergence, and the one most likely to be "simplified" back
    // into a bug. Three things are checked because all three are load-bearing.
    const { stdout } = await invoke(['flaky', '--json', '--limit', '1']);
    const header = json(stdout)['header'] as {
        scope: string;
        averageDays: number;
        scopeDates: string[];
        dayCount: number;
    };
    assertFraming('flaky', 'window', header.scope, 'average');
    assert.equal(header.averageDays, 7, 'a whole number of weeks, so the weekday mix cancels');
    assert.equal(header.scopeDates.length, 7);
    assert.equal(header.dayCount, 21, 'the file is still the 21-day aggregate');

    // The page's own tiles average the same 7 days, which is what makes the two
    // sides agree despite the table differing. Read off the page, not restated.
    const { AVERAGE_WINDOW } = await import('../site/flaky-view.ts');
    assert.equal(
        AVERAGE_WINDOW,
        7,
        "the CLI's ranking window is the page's headline-tile window; if the page changes it, " +
            'the two stop agreeing and the FRAMING reason needs re-reading'
    );

    // ...and the page's TABLE really does classify over the whole window, which
    // is the other half of the divergence.
    const source = await readFile(new URL('../site/flaky.ts', import.meta.url), 'utf8');
    assert.match(
        source,
        /tableAllDays = series\.days\.length > 1/,
        'the page table classifies over the whole window — the reading the CLI deliberately does ' +
            'not use as its default, because ~84% of tests have failed at least once in 21 days'
    );
});

test('flaky counts fail, timeout and crash — not just fail', async () => {
    // Timeouts are the largest of the three in this data, so a command counting
    // only FAIL would miss more than half and still look plausible. Asserted
    // through behaviour: a fixture test whose only failures are TIMEOUTs must
    // still be counted somewhere in the totals.
    // `--noise 0` so this measures the classification alone: the default filter
    // reads a test that failed once in 21 days as passing, and on this fixture
    // that is exactly one test — so a comparison against the filtered total
    // would be off by one for a reason that has nothing to do with the statuses.
    const { stdout } = await invoke(['flaky', '--json', '--limit', '0', '--all-days', '--noise', '0']);
    const result = json(stdout);
    const totals = result['totals'] as { flaky: number };

    const raw = JSON.parse(
        await readFile(new URL('./fixtures/xpcshell-issues.json', import.meta.url), 'utf8')
    ) as {
        tables: { statuses: string[] };
        testRuns: (Record<string, unknown> | null)[];
    };
    // Counted from the raw fixture, independently: how many tests have at least
    // one non-EXPECTED-FAIL failing status group of any of the three kinds.
    const failing = new Set<number>();
    const timeoutOnly = new Set<number>();
    for (let testId = 0; testId < raw.testRuns.length; testId++) {
        const perTest = raw.testRuns[testId];
        if (perTest === null || perTest === undefined) {
            continue;
        }
        let sawTimeoutOrCrash = false;
        let sawPlainFail = false;
        for (const [statusId, group] of Object.entries(perTest)) {
            if (group === null || group === undefined) {
                continue;
            }
            const status = raw.tables.statuses[Number(statusId)]!;
            if (status.startsWith('EXPECTED-FAIL')) {
                continue;
            }
            if (/^(TIMEOUT|CRASH)/.test(status)) {
                sawTimeoutOrCrash = true;
            } else if (status.startsWith('FAIL')) {
                sawPlainFail = true;
            }
        }
        if (sawTimeoutOrCrash || sawPlainFail) {
            failing.add(testId);
        }
        if (sawTimeoutOrCrash && !sawPlainFail) {
            timeoutOnly.add(testId);
        }
    }
    assert.ok(
        timeoutOnly.size > 0,
        'the fixture must contain a test whose only failures are timeouts or crashes, or this ' +
            'cannot distinguish "counts all three" from "counts fail only"'
    );
    // The whole-window flaky total is the count of tests that failed on any day,
    // which is exactly the set counted above.
    assert.equal(
        totals.flaky,
        failing.size,
        'the --all-days flaky total must be every test with a fail, timeout or crash — counting ' +
            `only FAIL would give ${failing.size - timeoutOnly.size}`
    );
});

test('flaky says which of the three windows it used, in text', async () => {
    // The page shipped tiles showing one day above a table showing 21 with
    // nothing saying so. Every scope has to name itself, or the numbers are
    // unreadable — 48%, 53% and 75% of the same folder. Naming it is all that is
    // required here; *why* each window behaves as it does is standing prose and
    // lives in `flaky --help`, not in the preamble of every run.
    const average = await invoke(['flaky', '--limit', '2']);
    assert.match(average.stdout, /Window: mean per day over the 7 days/);

    const all = await invoke(['flaky', '--limit', '2', '--all-days']);
    assert.match(all.stdout, /Window: --all-days/);

    const one = await invoke(['flaky', '--limit', '2', '--day', '2026-08-03']);
    assert.match(one.stdout, /Window: --day 2026-08-03/);

    // The ~84% denominator caveat that used to ride along on every --all-days run.
    const help = await invoke(['flaky', '--help']);
    assert.match(help.stdout, /~84% of/);
});

// =========================================================================
// fx-tests errors
// =========================================================================

test('errors defaults to mochitest, and reads the mochitest file', async () => {
    // The one command that does not default to xpcshell. Both halves matter:
    // the label, and which file was actually fetched — a command that reported
    // "mochitest" while reading the xpcshell file would pass a label check and
    // rank a failing-tests-only population as if it were all of CI.
    const { stdout, requested } = await invoke(['errors', '--json', '--limit', '1']);
    assertFraming('errors', 'harness', json(stdout)['harness'], 'mochitest');
    assert.ok(
        requested.some((name) => name.includes('mochitest-2026-08-03-errors.json')),
        `expected the mochitest errors file, got ${requested.join(', ')}`
    );
    assert.ok(!requested.some((name) => name.includes('xpcshell-2026-08-03-errors')));
});

test('the other tree-wide commands default to xpcshell', async () => {
    // The contrast that makes the line above a fact about `errors` rather than
    // about the CLI. Four commands, one assertion each, because a change that
    // flipped the default harness globally would otherwise look like a fix.
    for (const command of ['issues', 'failures', 'crashes', 'skips']) {
        const { stdout, requested } = await invoke([command, '--json', '--limit', '1']);
        const header = json(stdout)['header'] as { harness: string };
        assertFraming(command, 'harness', header.harness, 'xpcshell');
        assert.ok(
            requested.some((name) => name.startsWith('xpcshell-timings/')),
            `${command} must read the xpcshell index, got ${requested.join(', ')}`
        );
    }
});

test('errors rows are source locations, not message texts', async () => {
    // The row unit the page's "Message" option actually produces: `messageId`
    // interns (kind, text, file, line, component) (`old/errors.html:367`,
    // `:489-497`), so the same string from two source locations is two rows.
    // The CLI names that grouping `location` — a declared naming divergence —
    // and the identity has to be the same or the divergence is hiding a real
    // difference.
    const { stdout } = await invoke(['errors', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('errors', 'grouping', result['grouping'], 'location');

    const rows = result['rows'] as {
        kind: string | null;
        text: string | null;
        file: string | null;
        line: number | null;
        component: string | null;
    }[];
    assert.ok(rows.length > 1);
    // Every row is a distinct 5-tuple, which is what "the row unit is a source
    // location" means operationally.
    const keys = rows.map((row) =>
        JSON.stringify([row.kind, row.text, row.file, row.line, row.component])
    );
    assert.equal(new Set(keys).size, keys.length, 'each row must be a distinct messageId');

    // And the discriminating case: the location is part of the identity, so
    // there is at least one text that appears at more than one location. If the
    // fixture had no such text this assertion would be vacuous, so it is
    // checked rather than assumed.
    const byText = new Map<string, Set<string>>();
    for (const row of rows) {
        const text = row.text ?? '';
        const where = `${row.file}:${row.line}`;
        const set = byText.get(text) ?? new Set<string>();
        set.add(where);
        byText.set(text, set);
    }
    const split = [...byText.values()].some((locations) => locations.size > 1);
    assert.ok(
        split,
        'the errors fixture must contain one message text at two locations, or this test cannot ' +
            'distinguish grouping by location from grouping by text'
    );
});

test('errors ranks on occurrences descending, and covers one day', async () => {
    const { stdout } = await invoke(['errors', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('errors', 'sortKey', result['sort'], 'occurrences');
    const rows = result['rows'] as { count: number }[];
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.count >= rows[i]!.count,
            'errors must rank on occurrences descending (old/errors.html:232, comparator :476-483)'
        );
    }
    // One day, as `old/errors.html:1144-1152` says in as many words. There is no
    // multi-day errors aggregate, so this is the one window both sides can have.
    assert.equal(result['date'], '2026-08-03');
    assert.equal(
        result['availableDates'] instanceof Array && (result['availableDates'] as string[]).length,
        1
    );
});

test('errors counts every marker kind the file declares', async () => {
    // `old/errors.html:184-190` — seven checkboxes, all checked. The CLI has no
    // kind filter by default, and the check that says so is that the matched
    // total equals the file total.
    const { stdout } = await invoke(['errors', '--json', '--limit', '1']);
    const totals = json(stdout)['totals'] as { matched: number; file: number };
    assert.equal(
        totals.matched,
        totals.file,
        'with no --kind, every marker in the file must be counted (old/errors.html:184-190)'
    );
});

// =========================================================================
// fx-tests manifests
// =========================================================================

test('manifests rows are manifest paths ranked on median descending', async () => {
    // The one page whose default sort is not a count. `old/manifests.html:360-361`
    // sets `currentSortColumn = 'median'`, applied at `:499`.
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0']);
    const result = json(stdout);
    assertFraming('manifests', 'sortKey', result['sort'], 'median');

    const rows = result['rows'] as {
        manifest: string;
        durations: { median: number } | null;
    }[];
    assert.ok(rows.length > 1);
    let previous = Number.POSITIVE_INFINITY;
    for (const row of rows) {
        // A skipped manifest has no durations at all and sorts last, which is
        // the page's treatment of an all-zero pair (`:416`, `:441-442`, `:461`)
        // — reported as skipped rather than as a 0ms manifest.
        if (row.durations === null) {
            previous = Number.NEGATIVE_INFINITY;
            continue;
        }
        assert.ok(
            row.durations.median <= previous,
            `manifests must rank on median descending (old/manifests.html:360-361, applied :499); ` +
                `${row.manifest} has median ${row.durations.median} after ${previous}`
        );
        previous = row.durations.median;
    }
    // Row unit: one row per manifest, no repeats.
    const seen = new Set(rows.map((row) => row.manifest));
    assert.equal(seen.size, rows.length, 'the row unit is the manifest path (old/manifests.html:642-679)');
});

test('manifests reports skipped pairs as skipped, not as zero-duration', async () => {
    // The page excludes an all-zero pair from its statistics rather than
    // averaging a 0 into them. A CLI that let zeroes into the median would
    // report a fast manifest and rank it last, which reads as "this is fine".
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0']);
    const result = json(stdout);
    const zero = result['zeroDurations'] as { skippedPairs: number; totalPairs: number };
    assert.ok(zero.skippedPairs > 0, 'the fixture must contain skipped pairs');
    assert.ok(zero.skippedPairs < zero.totalPairs);

    const rows = result['rows'] as { durations: { median: number } | null }[];
    for (const row of rows) {
        if (row.durations !== null) {
            assert.ok(
                row.durations.median > 0,
                'a manifest with statistics must have a non-zero median; a zero means a skipped ' +
                    'pair leaked into the distribution (old/manifests.html:416, :441-442, :461)'
            );
        }
    }
});

test('manifests covers one artifact, with no date control', async () => {
    // `manifests.json` is a single day and there is no window to choose. Both
    // sides agree, and the CLI states the date rather than leaving the reader
    // to assume a 21-day window like every other command.
    const { stdout, requested } = await invoke(['manifests', '--json', '--limit', '1']);
    const metadata = json(stdout)['metadata'] as { date: string };
    assert.equal(metadata.date, '2026-08-03');
    assert.deepEqual(
        requested,
        ['manifest-timings/manifests.json'],
        'one artifact, and no index lookup for a window that does not exist'
    );
});

// =========================================================================
// fx-tests summary
// =========================================================================

test('summary is a 7-day window per harness, from the stats file', async () => {
    // The odd one out on two axes, and both are asserted because both are
    // easy to change by accident: 7 days where everything else is 21
    // (`old/index.html:524`, `:534` call `getRecentStats(stats, 7)`), and a
    // different file — `{harness}-stats.json`, not the issues aggregate.
    const { stdout, requested } = await invoke(['summary', '--json']);
    const harnesses = json(stdout)['harnesses'] as {
        harness: string;
        current: { dayCount: number };
        prior: { dayCount: number } | null;
    }[];
    assert.deepEqual(
        harnesses.map((entry) => entry.harness),
        ['xpcshell', 'mochitest'],
        'one row per harness, in source order — old/index.html:517-556 has no ranking'
    );
    for (const entry of harnesses) {
        assertFraming('summary', 'window', entry.current.dayCount, 7);
        assert.equal(entry.prior?.dayCount, 7, 'compared against the prior 7 days');
    }
    assert.deepEqual(
        [...requested].sort(),
        ['mochitest-timings/mochitest-stats.json', 'xpcshell-timings/xpcshell-stats.json'],
        'summary reads {harness}-stats.json, not the 21-day issues aggregate'
    );
});

test('summary reports invalid jobs separately rather than mixing them into one rate', async () => {
    // Not framing drift — a page bug the CLI declines to reproduce.
    // `old/index.html:476` subtracts invalid jobs from the Flaky Job Failures
    // numerator and `:479` leaves them in the denominator, so the rate can go
    // negative when invalid jobs exceed failed ones. The CLI keeps the two as
    // separate rows, which is why the numbers here are both non-negative.
    const { stdout } = await invoke(['summary', '--json', '--harness', 'xpcshell']);
    const [entry] = json(stdout)['harnesses'] as {
        current: { jobFailureRate: number; invalidJobRate: number };
    }[];
    assert.ok(entry !== undefined);
    assert.ok(entry.current.jobFailureRate >= 0);
    assert.ok(entry.current.invalidJobRate >= 0);
});

// =========================================================================
// fx-tests test
// =========================================================================

test('test lists failing configurations ranked on failure rate, not failure count', async () => {
    // The declared divergence from `test.html`'s variant × platform matrix: one
    // row per configuration, ranked by how often it fails rather than by run
    // count.
    //
    // Rate rather than count, and the fixture makes the difference observable:
    // the Windows config fails 4 of 109 runs (3.7%) and macOS 6 of 761 (0.8%),
    // so a count ranking would put macOS first and report the healthier config
    // as the worse one. `lib/query/config-stats.ts:362`.
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const result = json(stdout);
    const configs = result['configs'] as {
        jobName: string;
        failCount: number;
        failRate: number;
    }[];
    assert.ok(configs.length > 1, 'the fixture test fails on more than one config');
    for (let i = 1; i < configs.length; i++) {
        assert.ok(
            configs[i - 1]!.failRate >= configs[i]!.failRate,
            `test ranks configurations on failRate descending: ${configs[i - 1]!.jobName} at ` +
                `${configs[i - 1]!.failRate}% precedes ${configs[i]!.jobName} at ` +
                `${configs[i]!.failRate}%`
        );
    }
    // And the discriminating check: the two orders genuinely differ on this
    // fixture, so the assertion above is not passing by coincidence.
    const byCount = [...configs].sort((a, b) => b.failCount - a.failCount);
    assert.notDeepEqual(
        byCount.map((config) => config.jobName),
        configs.map((config) => config.jobName),
        'the fixture must order differently by count and by rate, or the rate assertion is vacuous'
    );
    // Every listed config failed — the default view is the failing ones, and
    // `--coverage` is the full picture. A zero-failure row here would mean the
    // default had quietly become the matrix.
    for (const config of configs) {
        assert.ok(
            config.failCount > 0,
            `${config.jobName} has no failures but is in the default view; the default is the ` +
                'failing configs (see the filters divergence in FRAMING)'
        );
    }
});

test('test states the window it used rather than assuming 21 days', async () => {
    // Marked `assertedFrom: source` in the table for the width itself: the 21
    // days is a property of the published file, so asserting "21" here would
    // assert the fixture. What the command can be held to is stating it.
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const metadata = json(stdout)['metadata'] as {
        startDate: string;
        endDate: string;
        dayCount: number;
        singleDay: boolean;
    };
    assert.equal(metadata.singleDay, false);
    assert.ok(metadata.dayCount > 1, 'the default is the whole window, not one day');
    assert.match(metadata.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(metadata.endDate, /^\d{4}-\d{2}-\d{2}$/);

    const entry = entryFor('test');
    assert.ok(
        entry.sourceOnly?.window !== undefined,
        'the window field is source-asserted for `test`; keep the reason in the table'
    );
});

test('test infers the harness from the path, as test.html does', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    assertFraming('test', 'harness', json(stdout)['harness'], 'xpcshell');
    const mochitest = await invoke([
        'test',
        'browser/components/tabbrowser/test/browser/tabs/browser_tab_dragdrop2.js',
        '--json',
    ]);
    assert.equal(json(mochitest.stdout)['harness'], 'mochitest');
});

test('test says where the test runs at all, so the narrowed view is not read as absence', async () => {
    // What makes the failing-configs default safe rather than misleading. The
    // page's matrix shows every cell; a terminal list of the failing ones
    // cannot answer "does this run on Android?", and that has to be settled
    // before concluding a platform is unaffected.
    const { stdout } = await invoke(['test', TEST_PATH]);
    assert.match(stdout, /^Runs on \d+ configs across /m);
});

// =========================================================================
// fx-tests try
// =========================================================================

/**
 * Runs `try` over canned jobs and profiles.
 *
 * Offline by construction: a fake Treeherder client and a profile fetcher over
 * hand-built profiles, the same seams `cli.test.ts` uses.
 */
async function invokeTry(
    argv: string[],
    jobs: TreeherderJob[],
    profiles: Record<string, string>
): Promise<Record<string, unknown>> {
    const streams = captureStreams();
    const code = await run({
        argv,
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder(jobs),
        fetchUrl: profileFetcher(profiles),
    });
    assert.equal(code, 0, streams.stderr);
    return json(streams.stdout);
}

/** A completed job. */
function job(jobName: string, taskId: string, result: string): TreeherderJob {
    return { jobId: 1, jobName, taskId, retryId: 0, state: 'completed', result };
}

test('try ranks on failing executions, not on distinct job runs', async () => {
    // PARITY.md §1's "order parity" row, and the only one of the three classes
    // that produces the same set in a different order. `old/try.html:1749` sorts on
    // `a.instances.length` — one entry per failing marker — so a test that
    // failed twice in one job outranks a test that failed once in two jobs.
    // Ranking on job runs instead flattens both to 2 and reverses them.
    //
    // The fixture is built to make exactly that distinction observable: TWICE
    // fails twice within one job, ONCE_EACH fails once in each of two jobs.
    const twice = 'dom/base/test/unit/test_twice_in_one_job.js';
    const onceEach = 'dom/base/test/unit/test_once_in_each_job.js';
    const result = await invokeTry(
        ['try', 'abcdef123456', '--json'],
        [
            job('test-linux2404-64/opt-xpcshell-1', 'TASKA', 'testfailed'),
            job('test-linux2404-64/opt-xpcshell-2', 'TASKB', 'testfailed'),
        ],
        {
            TASKA: profileWithFailures([
                { test: twice, executions: 3 },
                { test: onceEach, executions: 1 },
            ]),
            TASKB: profileWithFailures([{ test: onceEach, executions: 1 }]),
        }
    );

    const all = [
        ...(result['permaFails'] as { path: string; failureCount: number; jobNames: string[] }[]),
        ...(result['knownIntermittents'] as {
            path: string;
            failureCount: number;
            jobNames: string[];
        }[]),
        ...(result['newIntermittents'] as {
            path: string;
            failureCount: number;
            jobNames: string[];
        }[]),
    ];
    const byPath = new Map(all.map((entry) => [entry.path, entry]));
    const a = byPath.get(twice);
    const b = byPath.get(onceEach);
    assert.ok(a !== undefined && b !== undefined, `both tests must appear, got ${[...byPath.keys()]}`);

    // The discriminating pair: 3 executions in 1 job vs 2 executions in 2 jobs.
    assert.equal(a.failureCount, 3, 'three failing executions in one job');
    assert.equal(a.jobNames.length, 1, 'from a single configuration');
    assert.equal(b.failureCount, 2, 'one failing execution in each of two jobs');
    assert.equal(b.jobNames.length, 2, 'from two configurations');

    // The **emitted order**, which is the assertion that matters and the one an
    // earlier draft of this test was missing. Checking only that
    // `a.failureCount > b.failureCount` compares two numbers the command
    // reported and says nothing about the sequence it put them in: a mutation
    // ranking on `jobNames.length` instead survived that check, because it
    // still reported 3 and 2 correctly — it just emitted them the other way
    // round. That is precisely PARITY.md §1's "same set, wrong order", so the
    // sequence has to be asserted as a sequence.
    assert.deepEqual(
        all.map((entry) => entry.path),
        [twice, onceEach],
        'the ranking must put the 3-executions-in-1-job test first (old/try.html:1749, count = ' +
            'instances.length). Ranking on distinct job runs puts the 2-jobs test first and ' +
            'produces the same set in the wrong order — the defect PARITY.md §1 records as ' +
            'uncatchable by a value diff.'
    );
});

test('try breaks ties on the path, which the page does not', async () => {
    // The declared divergence. The page leaves equal counts in insertion order
    // and relies on the stability of two `sort()` calls, so its tie order is
    // the order eight web workers finished parsing profiles fetched 64 at a
    // time (`old/try.html:1113`) — a race that reshuffles between reloads. A
    // command whose output is pasted into bugs cannot be non-deterministic.
    //
    // Asserted by feeding the tied tests in reverse alphabetical order: if the
    // command kept insertion order the output would come back reversed.
    const first = 'dom/base/test/unit/test_aaa.js';
    const second = 'dom/base/test/unit/test_zzz.js';
    const result = await invokeTry(
        ['try', 'abcdef123456', '--json'],
        [job('test-linux2404-64/opt-xpcshell', 'TASKA', 'testfailed')],
        {
            TASKA: profileWithFailures([
                { test: second, executions: 2 },
                { test: first, executions: 2 },
            ]),
        }
    );
    const all = [
        ...(result['permaFails'] as { path: string; failureCount: number }[]),
        ...(result['knownIntermittents'] as { path: string; failureCount: number }[]),
        ...(result['newIntermittents'] as { path: string; failureCount: number }[]),
    ];
    const tied = all.filter((entry) => entry.failureCount === 2).map((entry) => entry.path);
    assert.deepEqual(
        tied,
        [first, second],
        'equal counts must order by path, not by the order the profiles were parsed'
    );
});

test('try counts an UNEXPECTED-PASS as a failure, as the page does', async () => {
    // `old/try.html:1486` puts UNEXPECTED-PASS in FAILURE_STATUSES, and it is the
    // one that reads as a contradiction: a test that passed when the manifest
    // said it would fail is a change the push caused, so leaving it out would
    // silently drop a real result. Asserted on output rather than by comparing
    // the two constant declarations, which would only prove the two files agree
    // about a name.
    const path = 'dom/base/test/unit/test_unexpected_pass.js';
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux2404-64/opt-xpcshell', 'TASKA', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASKA: JSON.stringify({
                meta: { startTime: 0 },
                threads: [
                    {
                        stringArray: ['test'],
                        markers: {
                            length: 1,
                            name: [0],
                            data: [{ type: 'Test', test: path, status: 'UNEXPECTED-PASS' }],
                            startTime: [1],
                            endTime: [2],
                        },
                    },
                ],
            }),
        }),
    });
    assert.equal(code, 0, streams.stderr);
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string }[]),
        ...(result['knownIntermittents'] as { path: string }[]),
        ...(result['newIntermittents'] as { path: string }[]),
    ];
    assert.deepEqual(
        all.map((entry) => entry.path),
        [path],
        'an UNEXPECTED-PASS must become a failure row (old/try.html:1486)'
    );
});

/**
 * The other half: the CLI must *derive* `UNEXPECTED-PASS`, not merely classify
 * one handed to it.
 *
 * The test above feeds `status: 'UNEXPECTED-PASS'` straight in, which proves
 * the constant is read and nothing about where the value comes from. Real
 * profiles never carry that status — the harness records `status: 'PASS'` with
 * an `expected` field, and the page turns the pair into `UNEXPECTED-PASS`
 * (`site/try.ts:455`). `data.expected` appeared nowhere in `cli/commands/try.ts`,
 * so a now-wrong `fail-if` annotation was a row on the page and invisible here,
 * while `FAILURE_STATUSES` — shared by both since the hoist — listed a value
 * only one consumer could emit.
 */
test('try derives UNEXPECTED-PASS from a PASS the manifest did not expect', async () => {
    const path = 'dom/base/test/unit/test_derived_unexpected_pass.js';
    const marker = (data: Record<string, unknown>): string =>
        JSON.stringify({
            meta: { startTime: 0 },
            threads: [
                {
                    stringArray: ['test'],
                    markers: {
                        length: 1,
                        name: [0],
                        data: [data],
                        startTime: [1],
                        endTime: [2],
                    },
                },
            ],
        });
    const rowsFor = async (data: Record<string, unknown>): Promise<string[]> => {
        const streams = captureStreams();
        const code = await run({
            argv: ['try', 'abcdef123456', '--json'],
            streams,
            source: fixtureSource(),
            cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
            treeherder: fakeTreeherder([job('test-linux2404-64/opt-xpcshell', 'TASKA', 'testfailed')]),
            fetchUrl: profileFetcher({ TASKA: marker(data) }),
        });
        assert.equal(code, 0, streams.stderr);
        const result = json(streams.stdout);
        return [
            ...(result['permaFails'] as { path: string; statuses: string[] }[]),
            ...(result['knownIntermittents'] as { path: string; statuses: string[] }[]),
            ...(result['newIntermittents'] as { path: string; statuses: string[] }[]),
        ].flatMap((entry) => entry.statuses);
    };

    // PASS where the manifest said FAIL: a row, and the status is derived.
    assert.deepEqual(
        await rowsFor({ type: 'Test', test: path, status: 'PASS', expected: 'FAIL' }),
        ['UNEXPECTED-PASS']
    );

    // The two neighbours, so the branch is a decision rather than a rewrite of
    // every PASS. A plain PASS is not a row at all...
    assert.deepEqual(await rowsFor({ type: 'Test', test: path, status: 'PASS' }), []);
    // ...and neither is a PASS the manifest expected.
    assert.deepEqual(
        await rowsFor({ type: 'Test', test: path, status: 'PASS', expected: 'PASS' }),
        []
    );
});

test('try groups into the three sections and covers the push, not a window', async () => {
    const result = await invokeTry(
        ['try', 'abcdef123456', '--json'],
        [job('test-linux2404-64/opt-xpcshell', 'TASKA', 'testfailed')],
        { TASKA: profileWithFailures([{ test: TEST_PATH, executions: 1 }]) }
    );
    // The grouping is the page's three tables (`old/try.html:1765-1766`), and every
    // key must be present even when a section is empty — an absent key would
    // make "no perma-fails" indistinguishable from "the field was dropped".
    for (const key of ['permaFails', 'knownIntermittents', 'newIntermittents']) {
        assert.ok(Array.isArray(result[key]), `try must always emit ${key}`);
    }
    // The window is the push: one push id, and the job count is what the fake
    // Treeherder returned rather than anything read from a 21-day file.
    assert.equal(result['pushId'], 1);
    assert.equal(result['jobCount'], 1);
});

test('try lists only test jobs by default; --other-jobs adds the rest', async () => {
    // Row framing, not universe framing: which failures get a row. The page
    // renders non-test failures apart from the tables (`old/try.html:816`), and
    // the command does the same. `--all-jobs` is a different axis and is
    // asserted by the two tests below it.
    const jobs = [
        job('test-linux2404-64/opt-xpcshell', 'TASKA', 'testfailed'),
        job('build-linux64/opt', 'TASKBUILD', 'busted'),
    ];
    const profiles = { TASKA: profileWithFailures([{ test: TEST_PATH, executions: 1 }]) };
    const result = await invokeTry(['try', 'abcdef123456', '--json'], jobs, profiles);

    // The non-test job is reported as such, and it is not a failure row: the
    // default sections are test failures only.
    const other = result['otherFailedJobs'] as { jobName: string }[];
    assert.deepEqual(other.map((entry) => entry.jobName), ['build-linux64/opt']);
    const all = [
        ...(result['permaFails'] as { path: string }[]),
        ...(result['knownIntermittents'] as { path: string }[]),
        ...(result['newIntermittents'] as { path: string }[]),
    ];
    assert.deepEqual(all.map((entry) => entry.path), [TEST_PATH]);

    // And the text default hides the build failures, as the unchecked box does.
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder(jobs),
        fetchUrl: profileFetcher(profiles),
    });
    assert.doesNotMatch(
        streams.stdout,
        /build-linux64/,
        'non-test job failures are behind --other-jobs; the default states the count only'
    );

    // And the flag prints them, so the assertion above is about the default
    // rather than about the list being unreachable.
    const withFlag = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--other-jobs'],
        streams: withFlag,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder(jobs),
        fetchUrl: profileFetcher(profiles),
    });
    assert.match(withFlag.stdout, /build-linux64/);
});

/**
 * The `universe` field, asserted behaviourally on the one command that has a
 * control on that axis.
 *
 * This is what the table was missing. `filters` said "non-test jobs opt-in" on
 * both sides and both statements were true, so nothing here could see that the
 * page's opt-in fetched more jobs while the command's opt-in only printed more
 * rows. The claim under test is a **count of profiles read**, which is the one
 * number that separates the two axes: a display filter cannot change it.
 *
 * The expected counts are literals read off the job list built two lines up —
 * 1 failed test job, 2 successful ones, 1 build. Deriving them by re-running
 * the command's own selector would assert nothing.
 */
test('try --all-jobs widens which jobs are read, not which rows are printed', async () => {
    const jobs = [
        job('test-linux2404-64/opt-xpcshell', 'TASKFAIL', 'testfailed'),
        job('test-linux2404-64/opt-xpcshell-2', 'TASKPASS1', 'success'),
        job('test-windows11-64-25h2/opt-mochitest-plain', 'TASKPASS2', 'success'),
        job('build-linux64/opt', 'TASKBUILD', 'success'),
    ];
    const profiles = {
        TASKFAIL: profileWithFailures([{ test: TEST_PATH, executions: 1 }]),
        TASKPASS1: profileWithFailures([]),
        TASKPASS2: profileWithFailures([]),
        TASKBUILD: profileWithFailures([]),
    };

    const byDefault = await invokeTry(['try', 'abcdef123456', '--json'], jobs, profiles);
    assert.equal(byDefault['profilesRead'], 1, 'the default reads the one failed test job');
    assert.equal(byDefault['readPassingJobs'], false);
    assert.equal(byDefault['passingTestJobCount'], 2, 'and says how many it did not read');

    const widened = await invokeTry(['try', 'abcdef123456', '--json', '--all-jobs'], jobs, profiles);
    assert.equal(widened['profilesRead'], 3, '--all-jobs adds the two successful TEST jobs');
    assert.equal(widened['readPassingJobs'], true);
    // Not the build job: `isTestJob` gates the addition on both sides, and a
    // build's artifact carries no test markers. 3, not 4.
    assert.equal(widened['passingTestJobCount'], 2);

    // The table's `universe` entry has to describe what just happened, or the
    // cross-side agreement check above is comparing two strings about nothing.
    // Matched on the two facts the counts demonstrate rather than on the whole
    // sentence, so rewording the prose does not fail the suite and dropping
    // either fact does.
    const declared = entryFor('try').cli.universe;
    assert.match(declared, /failed test jobs/);
    assert.match(declared, /opt-in/);
});

/**
 * The progress line and the header both have to name the set actually read.
 *
 * Not decoration. The "Reading N job profiles" wording exists because a line
 * that misdescribed the work made working caching look broken, and under
 * `--all-jobs` the failed-job count and the read count differ by a factor of
 * tens — so a line naming the smaller one while reading the larger set is the
 * same defect with a bigger number. Counts here are literals: 1 failed test
 * job and 2 successful ones, from the list below.
 */
test('try states how many profiles it read, and which set they were', async () => {
    const jobs = [
        job('test-linux2404-64/opt-xpcshell', 'TASKFAIL', 'testfailed'),
        job('test-linux2404-64/opt-xpcshell-2', 'TASKPASS1', 'success'),
        job('test-windows11-64-25h2/opt-mochitest-plain', 'TASKPASS2', 'success'),
    ];
    const profiles = {
        TASKFAIL: profileWithFailures([{ test: TEST_PATH, executions: 1 }]),
        TASKPASS1: profileWithFailures([]),
        TASKPASS2: profileWithFailures([]),
    };
    const runIt = async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
        const streams = captureStreams();
        await run({
            argv,
            streams,
            source: fixtureSource(),
            cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
            treeherder: fakeTreeherder(jobs),
            fetchUrl: profileFetcher(profiles),
        });
        return { stdout: streams.stdout, stderr: streams.stderr };
    };

    const byDefault = await runIt(['try', 'abcdef123456']);
    assert.match(byDefault.stderr, /Reading 1 job profiles \(one per failed test job\)/);
    assert.match(
        byDefault.stdout,
        /Read 1 failed test job profiles\. The 2 test jobs that passed were not read/,
        'the default has to say what it did not look at, or it reads as the whole push'
    );

    const widened = await runIt(['try', 'abcdef123456', '--all-jobs']);
    assert.match(
        widened.stderr,
        /Reading 3 job profiles \(one per completed test job, passing ones included\)/,
        'the count must be the set actually read, not the failed-job count'
    );
    assert.match(widened.stdout, /Read 3 test job profiles, including the 2 that passed/);
});

/**
 * The behaviour the flag exists for, end to end.
 *
 * A test that failed and then passed when the harness reran it inside a job
 * that Treeherder marks **green**. Nothing in the default universe references
 * that job, so the failure is not merely ranked lower — it is absent. This is
 * the case the page's tooltip names, and the reason `--all-jobs` had to stop
 * meaning something else.
 */
test('a test that failed and passed on retry appears only under --all-jobs', async () => {
    const RETRIED = 'dom/base/test/test_intermittent.html';
    const jobs = [
        job('test-linux2404-64/opt-xpcshell', 'TASKFAIL', 'testfailed'),
        job('test-linux2404-64/opt-mochitest-plain', 'TASKGREEN', 'success'),
    ];
    const profiles = {
        TASKFAIL: profileWithFailures([{ test: TEST_PATH, executions: 1 }]),
        // The green job: one FAIL, then a PASS inside the harness's `retry`
        // range. Treeherder still calls the job a success.
        TASKGREEN: profileWithRetryPass(RETRIED),
    };

    const byDefault = await invokeTry(['try', 'abcdef123456', '--json'], jobs, profiles);
    assert.deepEqual(
        rowPaths(byDefault),
        [TEST_PATH],
        'the green job is not read, so its failure cannot be reported'
    );

    const widened = await invokeTry(['try', 'abcdef123456', '--json', '--all-jobs'], jobs, profiles);
    assert.deepEqual(
        rowPaths(widened).sort(),
        [TEST_PATH, RETRIED].sort(),
        'with the successful jobs read, the retried failure surfaces'
    );

    // And it surfaces as an intermittent rather than a perma-fail: the
    // harness's rerun turned it green, which is the whole signal.
    const perma = (widened['permaFails'] as { path: string }[]).map((row) => row.path);
    assert.deepEqual(perma, [TEST_PATH], 'the retried test is not a perma-fail');
    const retried = [
        ...(widened['knownIntermittents'] as { path: string; passedOnRerun: boolean }[]),
        ...(widened['newIntermittents'] as { path: string; passedOnRerun: boolean }[]),
    ].find((row) => row.path === RETRIED);
    assert.ok(retried !== undefined, 'the retried test must land in an intermittent section');
    assert.equal(retried.passedOnRerun, true);
});

/** Every failure row the command emitted, across its three sections. */
function rowPaths(result: Record<string, unknown>): string[] {
    return [
        ...(result['permaFails'] as { path: string }[]),
        ...(result['knownIntermittents'] as { path: string }[]),
        ...(result['newIntermittents'] as { path: string }[]),
    ].map((row) => row.path);
}

/**
 * A profile in which `path` fails once, then passes inside the rerun range.
 *
 * The `retry` Text marker is what both parsers key the rerun phase on — see
 * `test/parity-harness.ts`'s `synthProfile`, which builds the same shape from
 * the pinned push. Written out here rather than reused from there because this
 * needs one specific pathology and that helper takes a whole push's timings.
 */
function profileWithRetryPass(path: string): string {
    const markers: { name: number; data: Record<string, unknown>; start: number; end: number }[] = [
        { name: 0, data: { type: 'Test', test: path, status: 'FAIL', message: 'boom' }, start: 1, end: 2 },
        // The rerun phase spans the second execution and nothing else.
        { name: 1, data: { type: 'Text', text: 'retry' }, start: 2.5, end: 6 },
        { name: 0, data: { type: 'Test', test: path, status: 'PASS' }, start: 3, end: 4 },
    ];
    return JSON.stringify({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test', 'retry'],
                markers: {
                    length: markers.length,
                    name: markers.map((marker) => marker.name),
                    data: markers.map((marker) => marker.data),
                    startTime: markers.map((marker) => marker.start),
                    endTime: markers.map((marker) => marker.end),
                },
            },
        ],
    });
}

// --- `try --test`: one test, per configuration -------------------------------

/**
 * A profile holding one job's attempts of `path`.
 *
 * `statuses` is the attempt sequence; everything after the first falls inside
 * the harness's `retry` range, which is what makes them retries rather than
 * separate runs. Three attempts is a real shape, not a synthetic one: 81 job
 * runs on push `7d16bff81bb1` hold three attempts of a single test.
 */
function profileWithAttempts(path: string, statuses: readonly string[]): string {
    const markers: { name: number; data: Record<string, unknown>; start: number; end: number }[] =
        [];
    const [first, ...retries] = statuses;
    markers.push({
        name: 0,
        data: { type: 'Test', test: path, status: first, message: 'boom' },
        start: 1,
        end: 2,
    });
    if (retries.length > 0) {
        markers.push({ name: 1, data: { type: 'Text', text: 'retry' }, start: 2.5, end: 100 });
        retries.forEach((status, index) => {
            markers.push({
                name: 0,
                data: { type: 'Test', test: path, status, message: 'boom' },
                start: 3 + index * 2,
                end: 4 + index * 2,
            });
        });
    }
    return JSON.stringify({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test', 'retry'],
                markers: {
                    length: markers.length,
                    name: markers.map((marker) => marker.name),
                    data: markers.map((marker) => marker.data),
                    startTime: markers.map((marker) => marker.start),
                    endTime: markers.map((marker) => marker.end),
                },
            },
        ],
    });
}

const TEST_REPORT_PATH = 'dom/base/test/unit/test_report_subject.js';

/**
 * One job run per bucket, plus the three-attempt case.
 *
 * - CLEAN passed on its only attempt.
 * - RETRIED failed once and the retry passed.
 * - THRICE failed, was retried twice, and the second retry passed — the case a
 *   two-attempt assumption gets wrong.
 * - BROKEN failed and its retry failed again, which is how most real failures
 *   look: 28 of the 31 on push `7d16bff81bb1`.
 */
function testReportJobs(): { jobs: TreeherderJob[]; profiles: Record<string, string> } {
    return {
        jobs: [
            job('test-linux/opt-mochitest-clean', 'CLEAN', 'success'),
            job('test-linux/opt-mochitest-retried', 'RETRIED', 'success'),
            job('test-linux/opt-mochitest-retried', 'THRICE', 'success'),
            job('test-linux/opt-mochitest-broken', 'BROKEN', 'testfailed'),
            // A green run of the SAME name as the failing one. Mode two never
            // downloads it, but the job list still counts it, which is what
            // makes that row read `2 jobs` rather than `1`.
            job('test-linux/opt-mochitest-broken', 'BROKENGREEN', 'success'),
        ],
        profiles: {
            CLEAN: profileWithAttempts(TEST_REPORT_PATH, ['PASS']),
            RETRIED: profileWithAttempts(TEST_REPORT_PATH, ['FAIL', 'PASS']),
            THRICE: profileWithAttempts(TEST_REPORT_PATH, ['FAIL', 'FAIL', 'PASS']),
            BROKEN: profileWithAttempts(TEST_REPORT_PATH, ['FAIL', 'FAIL']),
            BROKENGREEN: profileWithAttempts(TEST_REPORT_PATH, ['PASS']),
        },
    };
}

/**
 * The property the whole table rests on: the three outcome columns partition
 * `jobs`, so a row can never be read as not adding up.
 *
 * Asserted rather than left to the one-off probe that found it, because the
 * partition is what lets every column share a unit — and two rejected versions
 * of this table failed precisely by mixing job counts with attempt counts. A
 * change that reintroduced an attempt column would break this.
 */
test('try --test buckets every job run exactly once', async () => {
    const { jobs, profiles } = testReportJobs();
    const result = await invokeTry(
        ['try', 'abcdef123456', '--json', '--all-jobs', '--test', TEST_REPORT_PATH],
        jobs,
        profiles
    );
    const configs = result['configs'] as {
        jobName: string;
        jobs: number;
        passed: number;
        passedOnRetry: number;
        failed: number;
    }[];
    assert.equal(configs.length, 3, 'one row per configuration the test ran on');
    for (const row of configs) {
        assert.equal(
            row.passed + row.passedOnRetry + row.failed,
            row.jobs,
            `${row.jobName} does not partition: the columns must sum to jobs`
        );
    }

    const byName = new Map(configs.map((row) => [row.jobName, row]));
    assert.deepEqual(byName.get('test-linux/opt-mochitest-clean'), {
        jobName: 'test-linux/opt-mochitest-clean',
        jobs: 1,
        passed: 1,
        passedOnRetry: 0,
        failed: 0,
    });
    // Both jobs of this config needed a retry, and one of them needed two. The
    // column counts JOBS that were retried, not retries, so it reads 2 — the
    // attempt total is deliberately not recoverable from the row.
    assert.deepEqual(byName.get('test-linux/opt-mochitest-retried'), {
        jobName: 'test-linux/opt-mochitest-retried',
        jobs: 2,
        passed: 0,
        passedOnRetry: 2,
        failed: 0,
    });
    // A retry that failed again is still `failed`; it needs no fourth bucket.
    assert.deepEqual(byName.get('test-linux/opt-mochitest-broken'), {
        jobName: 'test-linux/opt-mochitest-broken',
        jobs: 2,
        passed: 1,
        passedOnRetry: 0,
        failed: 1,
    });
});

/**
 * Without `--all-jobs` the green jobs are never fetched, so both pass columns
 * measure nothing and are dropped rather than printed as zeros — the item's own
 * instruction, expressed by the table rather than by a footnote.
 */
/**
 * Without `--all-jobs` the green jobs are never downloaded, so a rescue inside
 * one cannot be seen and the two pass columns are bounds rather than counts.
 *
 * `jobs` still comes from the push's job list, which costs no request: the
 * failing configuration ran twice, and reporting `1` there would read as a
 * 100% failure rate for a test that failed in one run of two.
 */
test('try --test bounds the pass columns when the green jobs were not read', async () => {
    const { jobs, profiles } = testReportJobs();
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456', '--test', TEST_REPORT_PATH],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder(jobs),
        fetchUrl: profileFetcher(profiles),
    });
    assert.equal(code, 0, streams.stderr);
    const header = streams.stdout
        .split('\n')
        .find((line) => line.trimStart().startsWith('configuration'));
    assert.ok(header !== undefined, 'the table must have a header row');
    // The exact pair first, then the two the unread jobs only bound.
    assert.match(header, /^ {2}configuration\s+jobs\s+failed\s+passed on retry\s+passed$/);
    // Two jobs from the job list, one failure read, and the rest bounded. The
    // marker stays at zero: no rescue was SEEN, which is not "none happened".
    assert.match(streams.stdout, /opt-mochitest-broken\s+2\s+1\s+≥0\s+≤1$/m);
    // Only the configurations a failure was read from appear. The job list has
    // names, not test selection, so an all-green name may never have run this
    // test and listing it would be a fabrication.
    assert.doesNotMatch(streams.stdout, /opt-mochitest-clean/);
    assert.doesNotMatch(streams.stdout, /opt-mochitest-retried/);

    const widened = await invokeTry(
        ['try', 'abcdef123456', '--json', '--all-jobs', '--test', TEST_REPORT_PATH],
        jobs,
        profiles
    );
    assert.equal(
        (widened['configs'] as unknown[]).length,
        3,
        '--all-jobs must reach the configurations whose jobs were green'
    );
});
