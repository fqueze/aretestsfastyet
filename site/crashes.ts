/**
 * `crashes.html`, migrated onto `lib/`.
 *
 * Migrated as **one job** with `failures.html`, because the two are near-twins:
 * same row/path/test/occurrence drill-down, same collapse rule, same ranking,
 * same URL state. Doing them separately would have meant porting that structure
 * twice. The split:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/` | the file formats and the five status-group shapes | node tests, shared with the CLI |
 * | `site/drilldown-view.ts` | the shared view model: tree, ranking, collapse, totals, URL state | `test/drilldown-view.test.ts`, no DOM |
 * | `site/drilldown-render.ts` | the shared renderer | the browser parity run |
 * | `site/drilldown-controller.ts` | the shared controller: state, clicks, fetches, hash | `test/crashes-page.test.ts` and `test/failures-page.test.ts`, in jsdom |
 * | `site/crashes-view.ts` | what is only true of this page | `test/crashes-view.test.ts`, no DOM |
 * | this file | this page's `PageSpec`: its hooks, its chart walks, its URL rule | `test/crashes-page.test.ts` |
 *
 * The controller row is the newest. The two controllers were 897 and 922 lines
 * that a normalized diff put at 82% identical — the state, the four-level
 * expansion machine, the delegated click handler, `loadSelectedDate`, the
 * historical toggle and `start()` were the same code with the nouns swapped.
 * That is now `DrilldownController`, and what is left here is what genuinely
 * only this page does. **What was deliberately left duplicated** — the
 * search-box guard in `applyUrlState`, and the chart walk — is marked as such at
 * each site, with the reason.
 *
 * ## What the migration removes
 *
 * **The inline decoding of the status-group shapes.** `processCrashData`
 * (`old/crashes.html:225-374`) is 150 lines that branch on `isBucketedFormat` and
 * hand-decode `days` or `timestamps`, which covers two of the five shapes
 * `FORMATS.md` documents and silently misreads the other three.
 * `lib/formats/status-entries.ts` resolves all five and throws on a sixth.
 *
 * `common-test-data.js` is **not** loaded, and was **not loaded before either**
 * — unlike the three earlier migrations, this page never had the tag. Verified:
 * `grep -c common-test-data crashes.html` is 0, and none of its seven globals
 * (`detectHarness`, `getChunkIndex`, `getCountAtIndex`, `findTest`,
 * `stripChunkSuffix`, `computeConfigStats`, `computeTestStats`) appears in
 * either page's source. So there is nothing to remove here and no byte saved;
 * the brief's requirement that it stop being loaded is satisfied vacuously, and
 * saying so is more useful than implying a removal that did not happen.
 *
 * The six shared scripts **stay, loaded by name**: `shared.js`,
 * `fetch-utils.js`, `dashboards.js`, `common-ui.js`, `common-charts.js` and
 * `common-links.js`. They are UI plumbing with no `lib/` equivalent, up to 22
 * unmigrated pages depend on them, and `tools/build-pages.ts` copies them next
 * to the built page. `common-charts.js` in particular still owns the Chart.js
 * wiring and `getTestTotalRuns`, neither of which has a `lib/` counterpart.
 *
 * ## Declared divergences from `crashes.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set** — one enumerated list, no prose carrying an
 * eighth entry, because that is exactly how an entry went missing on an earlier
 * migration.
 *
 *  1. **Inline handler attributes become `addEventListener`.** The largest DOM
 *     difference by far. Upstream emits `onclick="sortBy('tests')"`,
 *     `onclick="sortBy('count')"` and `onclick="event.stopPropagation();"` on
 *     every occurrence link as **attributes**; this page attaches the same
 *     handlers and emits none of them. Measured in Chrome on the pinned
 *     snapshot, counting `on*` attributes in the live DOM: **old 2, new 0** at
 *     first paint (the two sort buttons), rising as rows are expanded — one per
 *     occurrence link. Behaviour-preserving, but it is what lets this file be a
 *     module instead of a bag of globals.
 *
 *  2. **`data-signature` is gone; rows are held in a `Map`.** Upstream writes
 *     `data-signature="${escapeAttr(sig)}"` on every row and finds a row again
 *     with `querySelector('[data-signature="' + escapeAttr(sig) + '"]')`
 *     (`:584`, `:597`). Here the renderer keeps the row elements in a `Map`
 *     keyed by the raw signature. **Measured: 0 of the 90 signatures on the
 *     pinned snapshot are affected by the escaping mismatch** — a signature is a
 *     symbol name and contains no quotes — so on this page the change removes a
 *     latent bug rather than a live one. (It is live on `failures.html`; see
 *     that file's entry 2.) **A DOM diff sees this as one absent attribute per
 *     row.**
 *
 *  3. **The total row's "Tests" number still overcounts.** It sums each row's
 *     test count, so a test that crashes with three signatures counts three
 *     times. Measured on the pinned snapshot: the row shows **1,098** where
 *     **676** distinct tests crashed, a 1.62× overcount, with 266 of those 676
 *     having more than one signature. **Reproduced unchanged.** The number is
 *     the sum of the column above it, a reader can check it by adding the rows
 *     up, and on a searched list it is the only number that responds to the
 *     search; replacing it with a distinct count would make it disagree with the
 *     column and with the reader's arithmetic, which is a product decision about
 *     a number a human reads rather than a migration's to make. The per-row
 *     count, by contrast, is *not* a double-count — see `GroupRow.testCount` for
 *     the measurement that establishes this.
 *
 *  4. **The search still hides rows without changing their numbers.**
 *     Reproduced exactly, including its two consequences: a surviving row shows
 *     its pre-filter counts and expands to tests that do not match, while the
 *     **total row does change** because it is summed after the filter. So under
 *     a search the total is the sum of the *whole* of each matching row.
 *     `failures.html` does the opposite; the difference is upstream's.
 *
 *  5. **An unsymbolized crash is still dropped.** Upstream skips a null
 *     signature (`:270`), where `lib/query/crashes.ts` deliberately keeps it as
 *     a `null` group on the grounds that an unsymbolized crash is still a crash.
 *     The page's rule is reproduced. Measured: **0 of 21,252 crash occurrences**
 *     on the pinned xpcshell snapshot have a null signature, so the two rules
 *     select the same runs here and this is a page-vs-CLI divergence rather than
 *     an old-vs-new one.
 *
 *  6. **A job name the file cannot resolve renders as empty, not `"undefined"`.**
 *     Upstream indexes `tables.jobNames[jobNameId]` with no guard, so a file
 *     with no `taskInfo` renders the string `undefined` into the cell. Here it
 *     is an empty string. Not reachable on either file this page loads — both
 *     carry `taskInfo` — so this is a difference in the unreachable branch, not
 *     in anything rendered on the pinned data.
 *
 * Two behaviours worth naming that are **not** divergences, because they were
 * measured to be identical and an earlier draft of this list wrongly claimed one
 * of them was a change:
 *
 * - **The historical-fetch-failure fallback.** When the 21-day fetch throws,
 *   `common-ui.js:262-271` writes the error into `#content`, leaves
 *   `isHistoricalMode` false, and `old/crashes.html:1032` then loads the selected
 *   date on top of it — so the error is overwritten by a normal single-day
 *   render and the reader is silently shown a different window than the one
 *   they asked for. Driven in Chrome with the 21-day file 404ing *and the CI
 *   origin blocked at the browser* — without the block, `fetch-utils.js:259`
 *   quietly satisfies the fetch from live CI and the scenario never happens,
 *   which is how the first run of this probe produced a 21-day view dated
 *   2026-07-15..08-04 instead of the pinned 07-14..08-03. With the block, both
 *   pages land on `{status: "1 301 test jobs", rows: 27, button: "Show Last 21
 *   Days", hash: ""}` — byte-identical, including the silent fallback.
 * - **The empty/failed single-day load.** With every data file 404ing, both
 *   pages show `{status: "Error loading data", .no-data: "Failed to fetch",
 *   rows: 0}`.
 *
 * Everything else — the row unit, the 21-day default, the sort keys and their
 * directions, the path collapse, the inline single occurrence, the tooltip and
 * its rounding, the chart wiring, and the `#date=…&q=…` state — is reproduced,
 * and the reasoning for each lives next to the code that does it in
 * `site/drilldown-view.ts`.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type GroupNode,
    type GroupRow,
    type Occurrence,
    type PathNode,
    type SortState,
    type TestNode,
    type UrlState,
    occurrenceTooltip,
} from './drilldown-view.ts';
import {
    type ChartRequest,
    type DailySeries,
    type PageSpec,
    type RankedList,
    DrilldownController,
} from './drilldown-controller.ts';
import {
    type RenderHooks,
    type Vocabulary,
    externalLink,
} from './drilldown-render.ts';
import { CRASH_NOUN, buildCrashGroups, crashRows, singleCrashOpensViewer } from './crashes-view.ts';
import { taskPageUrl } from './test-link.ts';

/** The class names and labels this page uses. See `Vocabulary`. */
const VOCAB: Vocabulary = {
    kind: 'crash',
    rowClass: 'crash-row',
    labelClass: 'crash-signature',
    statsClass: 'crash-stats',
    listClass: 'crash-list',
    countClass: 'crash',
    singleClass: 'single-crash',
    jobNameClass: 'crash-job-name',
    testCountClass: 'test-crash-count',
    labelHeader: 'Crash Signature',
    countHeader: 'Crashes',
    emptyText: 'No crash data available',
};

/**
 * This page's state and interactions.
 *
 * Everything that used to be a module-scope `let` here — `rawData`, `decoded`,
 * `groups`, `historicalData`, `isHistoricalMode`, `expandedSignature`, the two
 * expansion sets, `currentSort`, `rowsByKey`, `renderedRows` — is the
 * controller's, because the failures page kept the identical set under different
 * names. What this file reads back off it is `rawData` and `historicalData`, for
 * the three shared scripts that index into the untyped JSON themselves.
 *
 * Declared before `SPEC` and constructed at the bottom of the file: the hooks
 * and the chart walks below read `page.rawData` and `page.historicalData`, and
 * `SPEC` names those functions, so one of the two has to come first. A `const`
 * assigned at the end is the ordering that lets every function below read as
 * ordinary top-level code.
 */
let page: DrilldownController;

// --- ranking --------------------------------------------------------------

/**
 * The ranked rows, and the subtree every expansion reads.
 *
 * The map is the whole of `groups`, **not** the rows that survived the search.
 * That is this page's half of the search asymmetry and it reproduces
 * `old/crashes.html:858`, which expands out of `currentData.crashData`: a row's
 * expansion is never narrowed by the search, so a row matched only by a test
 * name still opens onto its full subtree. `failures.html` returns its
 * search-rewritten subtrees instead, which is why the shared controller reads
 * one map rather than branching on a flag.
 *
 * Keying off `groups` rather than off `rows` also matters for the re-attach
 * after a re-render: a row that is open when the search narrows past it keeps
 * finding its subtree, which is what upstream does.
 */
function rankSignatures(
    groups: Map<string, GroupNode>,
    term: string,
    sort: SortState
): RankedList {
    const expandable = new Map<string, Map<string, PathNode>>();
    for (const [signature, group] of groups) {
        expandable.set(signature, group.paths);
    }
    return { rows: crashRows(groups, term, sort), expandable };
}

// --- the page's hooks -----------------------------------------------------

/**
 * The Treeherder link for an occurrence, or `null`.
 *
 * `getTreeherderJobUrl` needs the raw file and does an `indexOf` over
 * `tables.taskIds` for every call, which is why the renderer asks for the
 * answer rather than computing it.
 */
function treeherderUrl(occurrence: Occurrence): string | null {
    if (page.rawData === null) {
        return null;
    }
    return getTreeherderJobUrl(occurrence, page.rawData);
}

const hooks: RenderHooks = {
    // A crash signature is plain text. `old/crashes.html:585`, which passes it
    // through `escapeHtml`.
    labelNodes: (key) => [key],
    // Upstream puts no `title` on a signature cell — unlike the failures page,
    // whose messages are truncated with an ellipsis and need one.
    labelTitle: () => undefined,

    occurrenceLinks(occurrence, testName) {
        // `renderCrashLinks` (`common-links.js:76`) in element form: Profile
        // always, Crash when a dump was uploaded, Job when the revision is
        // known.
        const links = [externalLink(getProfilerUrl(occurrence, testName), 'Profile')];
        const crashUrl = getCrashViewerUrl(occurrence);
        if (crashUrl) {
            links.push(externalLink(crashUrl, 'Crash'));
        }
        const jobUrl = treeherderUrl(occurrence);
        if (jobUrl !== null) {
            links.push(externalLink(jobUrl, 'Job'));
        }
        return links;
    },

    // The task page, which lists this run's crashes with their dumps.
    jobNameHref: (occurrence, testName) => taskPageUrl(occurrence.taskId, occurrence.retryId, testName),

    // This page has no bug-filing button. `failures.html` is the one with a
    // component to file against.
    testNameSuffix: () => null,

    singleRowHref: (occurrence) =>
        singleCrashOpensViewer(occurrence) ? getCrashViewerUrl(occurrence) : null,

    totalRunsOf: (dirPath, testName) =>
        page.historicalData === null
            ? 0
            : getTestTotalRuns(page.historicalData, dirPath, testName),

    tooltipOf: (count, totalRuns) => occurrenceTooltip(count, totalRuns, CRASH_NOUN),
};

// --- the charts -----------------------------------------------------------

/**
 * The daily rate series for a signature, path or test.
 *
 * These are `calculateSignatureDailyCrashRates` and friends
 * (`old/crashes.html:377-472`), which walk the *raw* historical file to collect the
 * test IDs to count and then hand them to `countDailyRunsForTests`
 * (`common-charts.js:149`). The shared function is kept, so the test-ID walk
 * stays on the raw file too — porting it to the decoded file would mean
 * `lib/` yielding test IDs that then index back into the raw arrays, which is
 * more coupling than the three call sites are worth.
 *
 * ## Why this walk is not shared with `site/failures.ts`
 *
 * The two are the same shape and not the same code, and unifying them would
 * cost more than it saves. The differences are four, and every one of them is
 * load-bearing:
 *
 * | | crashes | failures |
 * | --- | --- | --- |
 * | value table | `tables.crashSignatures` | `tables.messages` |
 * | field on a status group | `crashSignatureIds` | `messageIds` |
 * | status test | `=== 'CRASH'` (`old/crashes.html:435`) | `startsWith('FAIL')` |
 * | search-filtered variants | none | two (`old/failures.html:966`, `:1013`) |
 *
 * The status test in particular is *not* a parameter: this page matching a bare
 * `'CRASH'` and the other page matching a `FAIL` **prefix** is upstream's rule
 * on each page, `test/crashes-page.test.ts` pins the strict form here and
 * `test/failures-page.test.ts` pins the prefix form there, and a shared walk
 * taking a predicate would be a function whose only body is the loop the two
 * already agree on. The saving would be about 30 lines against two more
 * parameters and a predicate; that is the trade this codebase's rule says not to
 * make.
 */
interface HistoricalRaw {
    metadata: { days?: number; startTime: number };
    tables: { crashSignatures: string[]; statuses: string[]; testPaths: string[]; testNames: string[] };
    testInfo: { testPathIds: number[]; testNameIds: number[] };
    testRuns: ({ crashSignatureIds?: (number | null)[] } | null)[][];
}

/** The signature's table index in the historical file, or -1. */
function signatureId(historical: HistoricalRaw, signature: string): number {
    return historical.tables.crashSignatures.indexOf(signature);
}

function ratesFor(signature: string, keep: (testId: string) => boolean): DailySeries | null {
    if (page.historicalData === null) {
        return null;
    }
    const historical = page.historicalData as HistoricalRaw;
    const days = historical.metadata.days ?? 21;
    const start = historical.metadata.startTime;
    const targetId = signatureId(historical, signature);
    if (targetId === -1) {
        return countDailyRunsForTests(
            historical,
            new Set<string>(),
            targetId,
            'crashSignatureIds',
            'CRASH',
            days,
            start
        );
    }

    const testIds = new Set<string>();
    for (const testId in historical.testRuns) {
        if (!keep(testId)) {
            continue;
        }
        const testGroup = historical.testRuns[testId as unknown as number];
        if (!testGroup) {
            continue;
        }
        for (let statusId = 0; statusId < testGroup.length; statusId++) {
            const statusGroup = testGroup[statusId];
            if (!statusGroup) {
                continue;
            }
            // `=== 'CRASH'`, exactly as upstream (`old/crashes.html:435`).
            if (
                historical.tables.statuses[statusId] === 'CRASH' &&
                statusGroup.crashSignatureIds &&
                statusGroup.crashSignatureIds.some((id) => id === targetId)
            ) {
                testIds.add(testId);
                break;
            }
        }
    }

    return countDailyRunsForTests(
        historical,
        testIds,
        targetId,
        'crashSignatureIds',
        'CRASH',
        days,
        start
    );
}

const signatureDailyRates = (signature: string): DailySeries | null => ratesFor(signature, () => true);

const pathDailyRates = (signature: string, dirPath: string): DailySeries | null =>
    ratesFor(signature, (testId) => pathOf(testId) === dirPath);

/**
 * The per-test series.
 *
 * Upstream does *not* reuse the signature walk here: it finds the one test by
 * path and name and passes it straight to `countDailyRunsForTests`, without
 * checking that the test ever had the signature (`old/crashes.html:447-471`). That
 * difference is observable — the denominator is the test's runs either way, but
 * the walk-based version would exclude a test with no matching entries and this
 * one includes it with zero events — so it is reproduced rather than unified.
 */
function testDailyRates(
    signature: string,
    dirPath: string,
    testName: string
): DailySeries | null {
    if (page.historicalData === null) {
        return null;
    }
    const historical = page.historicalData as HistoricalRaw;
    const days = historical.metadata.days ?? 21;
    const start = historical.metadata.startTime;
    const targetId = signatureId(historical, signature);
    const testIds = new Set<string>();
    if (targetId !== -1) {
        for (const testId in historical.testRuns) {
            if (pathOf(testId) === dirPath && nameOf(testId) === testName) {
                testIds.add(testId);
                break;
            }
        }
    }
    return countDailyRunsForTests(
        historical,
        testIds,
        targetId,
        'crashSignatureIds',
        'CRASH',
        days,
        start
    );
}

function pathOf(testId: string): string {
    const historical = page.historicalData as HistoricalRaw;
    return historical.tables.testPaths[
        historical.testInfo.testPathIds[testId as unknown as number]!
    ]!;
}

function nameOf(testId: string): string {
    const historical = page.historicalData as HistoricalRaw;
    return historical.tables.testNames[
        historical.testInfo.testNameIds[testId as unknown as number]!
    ]!;
}

/**
 * Which series each of the three chart levels gets.
 *
 * `request.term` is ignored, and that is the page's rule rather than an
 * omission: this page's search hides whole rows and leaves the survivors' numbers
 * alone (divergence 4), so a visible row's chart is always the row's whole
 * series. `failures.html` rewrites its counts under a search and therefore has
 * two search-filtered chart variants; that difference is upstream's.
 */
function chartSeries(request: ChartRequest): DailySeries | null {
    switch (request.level) {
        case 'key':
            return signatureDailyRates(request.key);
        case 'path':
            return pathDailyRates(request.key, request.dirPath!);
        case 'test':
            return testDailyRates(request.key, request.dirPath!, request.testName!);
    }
}

// --- URL state ------------------------------------------------------------

/**
 * Applies the hash to the page. `loadFromUrlHash` (`old/crashes.html:981`).
 *
 * **Kept out of the shared controller on purpose.** The only line that differs
 * from `site/failures.ts`'s copy is the search-box guard, and the difference is
 * a declared divergence on both pages rather than an accident, so a shared
 * version would need a flag whose two settings are exactly the two pages. Two
 * short functions, each next to the paragraph that justifies it, is what this
 * codebase's rule asks for.
 *
 * Two upstream behaviours are reproduced deliberately:
 *
 * - **No date, or `21days`, means the 21-day view.** This is what makes
 *   historical the default despite `isHistoricalMode = false` at `:121`.
 * - **A `q` is only written into the box when it is truthy** (`:989`), so
 *   navigating from `#q=foo` to `#date=…` with no `q` leaves `foo` in the box
 *   and the list filtered by a term the URL no longer names. That is a bug, and
 *   it is on the divergence list as reproduced — see this file's entry list.
 */
async function applyUrlState(state: Partial<UrlState>): Promise<void> {
    const searchBox = document.getElementById('searchBox');
    if (document.activeElement !== searchBox && state.q) {
        page.searchBoxManager.setValue(state.q);
    }
    await page.applyDateState(state.date);
}

// --- startup --------------------------------------------------------------

/** Everything the shared controller cannot decide for this page. */
const SPEC: PageSpec = {
    vocab: VOCAB,
    hooks,
    heading: 'Crashes by Signature',
    keyChartPrefix: 'signature',
    chartEventLabel: 'crash',
    buildGroups: (file: DecodedTimingFile, startTime: number) =>
        buildCrashGroups(file, startTime),
    rank: rankSignatures,
    chartSeries,
    applyUrlState,
    // Upstream re-renders only via `loadSelectedDate`, so a hashchange that only
    // changes `q` while in the 21-day view updates the box and not the list.
    // Reproduced: this page does nothing here. `failures.html` had the same
    // behaviour and it is fixed there, which is that page's divergence 5 — see
    // `site/failures.ts` for why one page and not the other.
    onHashChangeInHistorical: () => {},
};

page = new DrilldownController(SPEC);

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * This used to be a bare `setupClickHandlers()` and an awaited IIFE at module
 * scope, which meant importing this file *started the page* — it attached
 * listeners, populated the date selector and fetched data. That is why nothing
 * tested it: `drilldown-render.ts` and the two controllers were 2,598 lines,
 * 60% of the migration, that no test could import, and inverting the page
 * branch in `inlineLinksCell` passed both `npm test` and `tsc`.
 *
 * Exporting the entry point is the whole fix. Everything above is now
 * declarations, so a test can import this module for its pure half — the
 * vocabulary, the hooks, the URL state — without a browser and without
 * fetching anything.
 */
export async function start(): Promise<void> {
    await page.start();
}

/**
 * The view model, for the browser parity harness.
 *
 * `PARITY.md` §2: a page that builds strings has no seam to compare against.
 * This is the seam — the ranked rows and the totals as plain values, so the
 * comparison can assert on decisions rather than on pixels. `try.html` exposes
 * `window.failures` for the same reason.
 */
window.__view = () => page.view();

export type { GroupRow, Occurrence, TestNode };
