/**
 * `failures.html`, migrated onto `lib/`.
 *
 * Migrated as **one job** with `crashes.html` — see `site/crashes.ts` for the
 * file split and why the two were done together. This file is the failures half:
 * this page's `PageSpec`, its hooks, its chart walks and its URL rule.
 *
 * The state, the four-level expansion machine, the delegated click handler,
 * `loadSelectedDate`, the historical toggle and `start()` are
 * `site/drilldown-controller.ts`, which this page and the crashes page share. A
 * normalized diff had put the two controllers at 82% identical. **What was
 * deliberately left duplicated** — `applyUrlState`, and the chart walk — is
 * marked as such at each site, with the reason.
 *
 * ## What the migration removes
 *
 * **The inline decoding of the status-group shapes.** `processFailureData`
 * (`old/failures.html:207-360`) is 150 lines branching on `isBucketedFormat`, which
 * covers two of the five shapes `FORMATS.md` documents.
 * `lib/formats/status-entries.ts` resolves all five and throws on a sixth.
 *
 * `common-test-data.js` is **not** loaded, and was not loaded before either —
 * `grep -c common-test-data failures.html` is 0. See `site/crashes.ts` for the
 * full note; the summary is that this page never had the tag, so the brief's
 * requirement is satisfied with nothing removed.
 *
 * The six shared scripts stay, loaded by name. `common-links.js` is doing real
 * work on this page in particular: `getBugzillaUrl` and `getBugButton` build the
 * 🐛 button, and `linkifyFailureMessage`'s Searchfox rule is reproduced as a
 * decision in `site/failures-view.ts` rather than called, because it returns
 * markup.
 *
 * ## Declared divergences from `failures.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set** — one enumerated list, no prose carrying an
 * extra entry.
 *
 *  1. **Inline handler attributes become `addEventListener`.** Upstream emits
 *     `onclick="sortBy('tests')"`, `onclick="sortBy('count')"`,
 *     `onclick="window.open('…', '_blank')"` on every single-failure row, and
 *     `onclick="event.stopPropagation();"` on every link and every 🐛 button, as
 *     **attributes**. This page attaches the same handlers and emits none of its
 *     own. Measured in Chrome on the pinned snapshot at first paint: **old 2,
 *     new 0**, rising as rows expand.
 *
 *     One `onclick` does survive in the new page's DOM and it is not this
 *     page's: the 🐛 button's markup comes from `getBugButton`
 *     (`common-links.js:216`), a shared script this migration keeps, and it
 *     writes `onclick="event.stopPropagation();"` into the string it returns.
 *     Its count therefore tracks the number of bug buttons rather than the
 *     number of rows.
 *
 *  2. **`data-message` is gone; rows are held in a `Map` — and this fixes a
 *     live bug.** Upstream writes `data-message="${escapeAttr(msg)}"` and finds
 *     a row again with `querySelector('[data-message="' + escapeAttr(msg) +
 *     '"]')` (`:670`, `:683`). The round-trip does not survive a quote:
 *     `escapeAttr` writes `&quot;`, the HTML parser decodes it back to `"` in
 *     the attribute value, and the CSS selector then looks for the literal text
 *     `&quot;`.
 *
 *     **Measured in Chrome on the pinned snapshot: 1,848 of the 2,841 rows
 *     (65%) cannot find themselves.** And it is live: expanding
 *     `Unexpected exception TypeError: can't access property "resumed", …`
 *     gives it 2 sub-rows, and clicking a column header to re-sort leaves that
 *     row with the `expanded` class, `expandedMessage` still pointing at it, and
 *     **0 sub-rows** — a highlighted row with nothing under it that then needs
 *     two clicks to open. A quote-free control row is unaffected by the same
 *     steps.
 *
 *     Here the row elements live in a `Map` keyed by the raw message, so the
 *     round-trip does not exist. **A DOM diff sees one absent attribute per
 *     row; a reader sees a row that reopens.**
 *
 *  3. **The total row's "Tests" number still overcounts.** It sums each row's
 *     test count, so a test failing with several messages counts once per
 *     message. Measured on the pinned snapshot: the row shows **7,976** where
 *     **3,793** distinct tests failed, a 2.10× overcount. **Reproduced
 *     unchanged**, for the reason given in `totalsOf`: it is the sum of the
 *     column above it and a reader checks it by adding the rows up.
 *
 *  4. **The search still rewrites the counts on the rows.** Reproduced exactly,
 *     including the part that surprises: a row whose *message* does not match
 *     shows a **smaller count under a search than without one**, because it is
 *     recomputed from only the tests that matched. `crashes.html` does the
 *     opposite — it leaves the numbers alone and drops whole rows — and the
 *     difference between the two pages is upstream's, not this migration's.
 *
 *  5. **A stale search box is now cleared on hashchange.** `old/failures.html:1100`
 *     is `if (document.activeElement !== searchBox && state.q)`, so a hash with
 *     no `q` never *clears* the box: navigating from `#q=netwerk` to
 *     `#date=2026-08-04` leaves `netwerk` in the box and the list filtered by a
 *     term the URL no longer names, and the next hash write puts `q=netwerk`
 *     back. **This is the one behaviour change on this list.**
 *
 *     Why fixed here and not left alone: the alternative is a page whose
 *     displayed state contradicts its own URL, which breaks the property
 *     `PARITY.md` §4 names explicitly — "a shared link must produce the same
 *     view on both". A link with no `q` must not produce a filtered list. The
 *     new page writes `state.q ?? ''`, so an absent `q` clears the box, and the
 *     focus guard is kept unchanged so typing is never interrupted.
 *
 *     `old/crashes.html:989` has the identical bug. It is **not** fixed there — see
 *     that file's list — because the crashes page's search only hides rows,
 *     while this page's search rewrites every number on screen, so the stale
 *     state is far more misleading here. Fixing one and not the other is a
 *     deliberate asymmetry rather than an oversight, and it is stated on both
 *     lists so a reviewer sees it from either side.
 *
 *  6. **A job name the file cannot resolve renders as empty, not `"undefined"`.**
 *     Same as `crashes.html`'s entry 6, and equally unreachable on the files
 *     this page loads.
 *
 *  7. **The message's Searchfox link is built from parts.**
 *     `linkifyFailureMessage` (`common-ui.js:22`) returns a string of HTML that
 *     the page interpolates; here `messageLink()` returns the split point and
 *     the renderer builds an anchor and a text node. The rendered text and the
 *     href are identical — `test/failures-view.test.ts` asserts the split
 *     against the shared function's own regex — and the difference a DOM diff
 *     sees is the absent `onclick` on the anchor, which is entry 1.
 *
 * Everything else — the row unit including the rankable `(no failure message)`
 * row, the `FAIL*` prefix universe, the 21-day default, the sort keys, the path
 * collapse, the bug button's `Product :: Component` guard, the tooltip and its
 * rounding, the four chart variants including the two search-filtered ones, and
 * the `#date=…&q=…` state — is reproduced.
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
import { taskPageUrl } from './test-link.ts';
import {
    FAILURE_NOUN,
    buildFailureGroups,
    failureList,
    hasBugButton,
    messageLink,
    mostFrequentTestPath,
} from './failures-view.ts';

// --- the one shared-script global this page uses and `drilldown-render` does
// not ------------------------------------------------------------------------

declare global {
    /**
     * `common-links.js:215` — the 🐛 button's markup.
     *
     * Declared here, in the file that calls it, rather than being borrowed from
     * `site/test.ts`. The two projects disagree about what "the program" is:
     * `tsconfig.site.json` compiles all of `site/**` at once, so a declaration
     * anywhere in `site/` satisfies a call anywhere else in it, while the root
     * `tsconfig.json` pulls in only the files a test actually imports — so a
     * node test importing this module got `TS2552: Cannot find name
     * 'getBugButton'` until this block existed. `test/dom-harness.ts` carried
     * the declaration as a workaround; this is where it belongs.
     *
     * `declare global` blocks **merge** rather than shadow, so the identical
     * declaration in `site/test.ts` is not a conflict — but the two signatures
     * have to stay identical, which is why both name `common-links.js:215`.
     */
    function getBugButton(bugUrl: string, tooltipText?: string): string;
}

/** The class names and labels this page uses. See `Vocabulary`. */
const VOCAB: Vocabulary = {
    kind: 'failure',
    rowClass: 'failure-row',
    labelClass: 'failure-message',
    statsClass: 'failure-stats',
    listClass: 'failure-list',
    countClass: 'fail',
    singleClass: 'single-failure',
    jobNameClass: 'failure-job-name',
    testCountClass: 'test-failure-count',
    labelHeader: 'Failure Message',
    countHeader: 'Failures',
    emptyText: 'No failure data available',
};

/**
 * This page's state and interactions. See `site/crashes.ts` for why the
 * controller is shared and why the instance is constructed at the bottom.
 */
let page: DrilldownController;

// --- ranking --------------------------------------------------------------

/**
 * The ranked rows, and the search-rewritten subtree every expansion reads.
 *
 * `failureList` already returns both, because `filteredFailureData`
 * (`old/failures.html:101`) is what makes this page's search consistent: expanding a
 * row under a search shows only the tests that matched, and the counts on the
 * row are the counts of what expanding it will reveal.
 *
 * This is the other half of the asymmetry the shared controller absorbs into one
 * map: `site/crashes.ts` returns the whole unfiltered tree here, so its rows
 * expand to everything. Neither page needs a flag; each returns the map its own
 * semantics call for.
 */
function rankMessages(
    groups: Map<string, GroupNode>,
    term: string,
    sort: SortState
): RankedList {
    return failureList(groups, term, sort);
}

// --- the page's hooks -----------------------------------------------------

/**
 * The 🐛 bug-filing button for a test row, or `null`.
 *
 * `generateBugButton` (`old/failures.html:749`). The markup comes from
 * `getBugButton` (`common-links.js:216`), which returns a string — so this is
 * the one place the new page parses HTML, and it does so through a `<template>`
 * rather than by assigning into the live tree. Building the anchor here instead
 * would mean duplicating the shared function's markup and its tooltip, which is
 * exactly the duplication this migration is trying not to create.
 */
function bugButton(testPath: string, message: string, test: TestNode): Node | null {
    const component = test.component;
    if (!hasBugButton(component)) {
        return null;
    }
    const { firstDate, lastDate } = getDataDateRange(page.rawData);
    const totalRuns = hooks.totalRunsOf(testPath.slice(0, testPath.lastIndexOf('/')), test.testName);
    const url = getBugzillaUrl({
        testPath,
        summary: message,
        component: component!,
        stats: { failureCount: test.totalCount, firstDate, lastDate, totalRuns },
    });
    const template = document.createElement('template');
    template.innerHTML = getBugButton(url);
    return template.content.firstElementChild;
}

const hooks: RenderHooks = {
    /**
     * The message, with its `[file : line]` prefix linked to Searchfox.
     *
     * `linkifyFailureMessage` (`common-ui.js:22`) in element form. The test path
     * the link points at is the most-failing test of the row
     * (`old/failures.html:659`), which is why this is a closure over the current
     * rows rather than a pure function of the key.
     */
    labelNodes(key) {
        const split = messageLink(key);
        if (split === null) {
            return [key];
        }
        const row = page.renderedRows.find((candidate) => candidate.key === key);
        const testPath = row === undefined ? null : mostFrequentTestPath(row.paths);
        const href = getSearchfoxUrl(testPath ?? '', key);
        return [externalLink(href, split.linked), split.rest];
    },

    // `old/failures.html:671` puts the whole message in a `title`, because the cell
    // is `text-overflow: ellipsis` and a long message is cut off.
    labelTitle: (key) => key,

    occurrenceLinks() {
        // None: the job name is the `task.html` link, which has the profile
        // and the Treeherder job. A failure has no dump to link to.
        return [];
    },

    jobNameHref: (occurrence, testName) => taskPageUrl(occurrence.taskId, occurrence.retryId, testName),

    testNameSuffix: (dirPath, test, key) => bugButton(`${dirPath}/${test.testName}`, key, test),

    // A failure row always has a task, so unlike a crash row it is never inert.
    singleRowHref: (occurrence, testName) => taskPageUrl(occurrence.taskId, occurrence.retryId, testName),

    totalRunsOf: (dirPath, testName) =>
        page.historicalData === null
            ? 0
            : getTestTotalRuns(page.historicalData, dirPath, testName),

    tooltipOf: (count, totalRuns) => occurrenceTooltip(count, totalRuns, FAILURE_NOUN),
};

// --- the charts -----------------------------------------------------------

/**
 * The daily rate series walk.
 *
 * Deliberately **not** shared with `site/crashes.ts`, which has the same shape
 * and not the same code. The four differences — the value table, the field on a
 * status group, the status test (`startsWith('FAIL')` here against a bare
 * `=== 'CRASH'` there), and the two search-filtered variants this page has and
 * that one does not — are each upstream's rule for its own page, each pinned by
 * that page's own suite. See the table in `site/crashes.ts`'s copy for the full
 * argument; the short version is that unifying them buys about 30 lines and
 * costs two parameters and a predicate.
 */
interface HistoricalRaw {
    metadata: { days?: number; startTime: number };
    tables: { messages: string[]; statuses: string[]; testPaths: string[]; testNames: string[] };
    testInfo: { testPathIds: number[]; testNameIds: number[] };
    testRuns: ({ messageIds?: (number | null)[] } | null)[][];
}

/**
 * The message's table index, or -1.
 *
 * `'(no failure message)'` is a *display* name this page invents, not a table
 * entry, so `indexOf` returns -1 for it and its chart is all zeroes. That is
 * upstream's behaviour (`old/failures.html:368` on a message that is not in
 * `tables.messages`) and is reproduced: the top row of the page has an empty
 * chart on both.
 */
function messageId(historical: HistoricalRaw, message: string): number {
    return historical.tables.messages.indexOf(message);
}

/** Counts the series for an explicit set of test IDs. */
function ratesForTests(message: string, testIds: Set<string>): DailySeries | null {
    if (page.historicalData === null) {
        return null;
    }
    const historical = page.historicalData as HistoricalRaw;
    return countDailyRunsForTests(
        historical,
        testIds,
        messageId(historical, message),
        'messageIds',
        'FAIL',
        historical.metadata.days ?? 21,
        historical.metadata.startTime
    );
}

/** The tests that ever produced this message, optionally within one path. */
function ratesFor(message: string, keep: (testId: string) => boolean): DailySeries | null {
    if (page.historicalData === null) {
        return null;
    }
    const historical = page.historicalData as HistoricalRaw;
    const targetId = messageId(historical, message);
    if (targetId === -1) {
        return ratesForTests(message, new Set<string>());
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
            const status = historical.tables.statuses[statusId];
            if (
                status !== undefined &&
                status.startsWith('FAIL') &&
                statusGroup.messageIds &&
                statusGroup.messageIds.some((id) => id === targetId)
            ) {
                testIds.add(testId);
                break;
            }
        }
    }
    return ratesForTests(message, testIds);
}

const messageDailyRates = (message: string): DailySeries | null => ratesFor(message, () => true);

const pathDailyRates = (message: string, dirPath: string): DailySeries | null =>
    ratesFor(message, (testId) => pathOf(testId) === dirPath);

/**
 * The per-test series.
 *
 * As on the crashes page, upstream does not reuse the walk here: it finds the
 * one test by path and name without checking that it ever had the message
 * (`old/failures.html:489-513`). Reproduced.
 */
function testDailyRates(message: string, dirPath: string, testName: string): DailySeries | null {
    if (page.historicalData === null) {
        return null;
    }
    const historical = page.historicalData as HistoricalRaw;
    const testIds = new Set<string>();
    if (messageId(historical, message) !== -1) {
        for (const testId in historical.testRuns) {
            if (pathOf(testId) === dirPath && nameOf(testId) === testName) {
                testIds.add(testId);
                break;
            }
        }
    }
    return ratesForTests(message, testIds);
}

/** Every test ID named by a (possibly search-rewritten) subtree. */
function testIdsOfSubtree(paths: Map<string, PathNode>): Set<string> {
    const ids = new Set<string>();
    for (const path of paths.values()) {
        for (const testId of testIdsOfPath(path.dirPath, path)) {
            ids.add(testId);
        }
    }
    return ids;
}

/**
 * The test IDs of one path's tests.
 *
 * Upstream's `calculateFilteredPathDailyFailureRates` (`old/failures.html:462`) does
 * this as a nested loop over every test in the file *per test name*, which is
 * O(tests × names). One pass over the file with a name set is the same answer;
 * the difference is only in how long it takes, and on the 4,838-test xpcshell
 * file the old form is visible as a pause when expanding a searched row.
 */
function testIdsOfPath(dirPath: string, path: PathNode): Set<string> {
    const ids = new Set<string>();
    if (page.historicalData === null) {
        return ids;
    }
    const historical = page.historicalData as HistoricalRaw;
    const names = new Set(path.tests.keys());
    for (const testId in historical.testRuns) {
        if (pathOf(testId) === dirPath && names.has(nameOf(testId))) {
            ids.add(testId);
        }
    }
    return ids;
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
 * Which series each of the three chart levels gets — four variants, not three.
 *
 * This is the page-specific half the shared controller cannot have: under a
 * search, a row whose own text did not match gets a chart restricted to the
 * tests that did, so the chart agrees with the count the search rewrote onto the
 * row. `crashes.html` has no equivalent because its search leaves the numbers
 * alone. Upstream's two guards are `old/failures.html:966-974` and `:1013-1021`, and
 * there is deliberately none at the test level (`:1063`) because a single test
 * either matched or is not on screen.
 */
function chartSeries(request: ChartRequest): DailySeries | null {
    const { key: message, term } = request;

    switch (request.level) {
        case 'key': {
            // `old/failures.html:966-974`, in upstream's own phrasing: a row whose
            // message did not itself match gets the restricted chart.
            const filtered = term !== '' && !message.toLowerCase().includes(term);
            const paths = request.paths as Map<string, PathNode>;
            return filtered
                ? ratesForTests(message, testIdsOfSubtree(paths))
                : messageDailyRates(message);
        }
        case 'path': {
            // `old/failures.html:1013-1021`: the filtered variant applies when
            // neither the message nor the path matched the search.
            const dirPath = request.dirPath!;
            const filtered =
                term !== '' &&
                !message.toLowerCase().includes(term) &&
                !dirPath.toLowerCase().includes(term);
            return filtered
                ? ratesForTests(message, testIdsOfPath(dirPath, request.paths as PathNode))
                : pathDailyRates(message, dirPath);
        }
        case 'test':
            return testDailyRates(message, request.dirPath!, request.testName!);
    }
}

// --- URL state ------------------------------------------------------------

/**
 * Applies the hash to the page. `loadFromUrlHash` (`old/failures.html:1092`).
 *
 * **Kept out of the shared controller on purpose**, for the reason given in
 * `site/crashes.ts`'s copy: the only line that differs between the two pages is
 * the search-box guard, and that difference is a declared divergence rather than
 * an accident, so a shared version would take a flag whose two settings are
 * exactly the two pages.
 *
 * The one behaviour change on this page's divergence list is here: upstream's
 * `state.q` guard (`:1100`) means an absent `q` never clears the box, so a link
 * with no search term produces a filtered list. `state.q ?? ''` clears it. The
 * focus guard is unchanged, so a hashchange never interrupts typing.
 */
async function applyUrlState(state: Partial<UrlState>): Promise<void> {
    const box = document.getElementById('searchBox');
    if (document.activeElement !== box) {
        page.searchBoxManager.setValue(state.q ?? '');
    }
    await page.applyDateState(state.date);
}

// --- startup --------------------------------------------------------------

/** Everything the shared controller cannot decide for this page. */
const SPEC: PageSpec = {
    vocab: VOCAB,
    hooks,
    heading: 'Failures by Message',
    keyChartPrefix: 'message',
    chartEventLabel: 'failure',
    buildGroups: (file: DecodedTimingFile, startTime: number) =>
        buildFailureGroups(file, startTime),
    rank: rankMessages,
    chartSeries,
    applyUrlState,
    // Upstream re-renders only via `loadSelectedDate`, so a hashchange that only
    // changes `q` while in the 21-day view updates the box and not the list.
    // Rendering here is what makes the fix in divergence 5 observable rather
    // than cosmetic. `site/crashes.ts` reproduces upstream and does nothing.
    onHashChangeInHistorical: () => page.render(),
};

page = new DrilldownController(SPEC);

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * See `site/crashes.ts` for why this is exported rather than run at module
 * scope: importing a controller used to start the page, which is what left the
 * renderers and controllers untestable.
 */
export async function start(): Promise<void> {
    await page.start();
}

/** The view model, for the browser parity harness. See `site/crashes.ts`. */
window.__view = () => page.view();

export type { GroupRow, Occurrence, TestNode };
