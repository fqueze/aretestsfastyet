/**
 * `site/issues-view.ts` — the view model behind the migrated issues page.
 *
 * ## Where the expected values come from
 *
 * **Not from the thing under test.** This project has had *eight* occurrences
 * of a test whose expectation was produced by the code it was checking; one
 * shipped a visibly wrong digit, two pinned bugs as correct, and one was inside
 * the file written to prevent them.
 *
 * So the numbers below are tallied **by hand off the raw fixture arrays** —
 * `testRuns[t][s].counts`, summed against `tables.statuses` — with no call into
 * `lib/query/issues.ts` or `site/issues-view.ts`. `TALLY` is that hand count,
 * written out as literals, and `handTally()` re-derives it from the file so
 * that a fixture swap fails loudly instead of silently comparing a stale
 * constant. The two are asserted equal before anything else runs.
 *
 * For each assertion the question asked was: **what wrong implementation still
 * passes this?** Where the answer was "a plausible one", the test was changed
 * — the search tests assert what *disappears* as well as what survives,
 * because an earlier test in this repo asserted a filter "keeps rows whole"
 * while never checking that non-matching rows go away, and the filter could
 * have been deleted with every test still green.
 *
 * ## Mutation survivors, and why each is left
 *
 * 29 mutations were run against `site/issues-view.ts` and `site/issues.ts`.
 * 26 were caught by a named test. The three that survive are recorded here
 * with their measurements rather than papered over:
 *
 * 1. **Filtering the issue list before sorting it instead of after.**
 *    Unfalsifiable by construction, not by omission: removing elements from a
 *    sorted list leaves the survivors in the same relative order, so the two
 *    orders are equal for *every* input. `issueEntries` keeps upstream's
 *    order (`old/issues.html:3037` then `:3040`) because it is upstream's; no test
 *    can distinguish them and none pretends to.
 * 2. **Counting `run-if` skips as issues.** Measured: **0 of 189 SKIP entries
 *    in the fixture and 0 of 27,024 in the full pinned 21-day xpcshell file**
 *    carry a `run-if` message — `FORMATS.md` records that the generator
 *    already drops them from the aggregates. So the branch is correct and
 *    currently unreachable on every aggregate this page loads. It stays
 *    because a daily file *does* carry them (up to 2.7× the skip count) and
 *    `#date=<day>` loads one.
 * 3. **Renaming the `(no component)` bucket.** Measured: **0 of 10 fixture
 *    tests** lack a component, against **2 of 4,838** in the full file. The
 *    fixture cannot reach the branch. Left rather than asserted against a
 *    hand-built decoded file, which would be asserting a constant.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeIssues } from '../lib/formats/issues.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import {
    type IssueFilters,
    ALL_FILTERS,
    CRASH_NO_SIGNATURE,
    DEFAULT_VIEW,
    FAILURE_NO_MESSAGE,
    INITIAL_SORT,
    NO_COMPONENT,
    STAT_COLUMNS,
    TIMEOUT_MESSAGE,
    VIEW_MODES,
    buildComponentRows,
    buildTestRows,
    effectiveView,
    failureTooltip,
    groupingOf,
    hasComponentData,
    headerCounts,
    isHistoricalDate,
    isViewMode,
    issueEntries,
    nextSort,
    percentageDisplay,
    readUrlState,
    sortComponents,
    sortTests,
    typesOf,
} from '../site/issues-view.ts';

const raw = JSON.parse(
    readFileSync(new URL('./fixtures/xpcshell-issues.json', import.meta.url), 'utf8')
) as IssuesFile;
const file = decodeIssues(structuredClone(raw));

// =========================================================================
// The hand tally
// =========================================================================

interface Tally {
    name: string;
    component: string;
    /** pass + expected-fail + fail + timeout + crash. Excludes skips. */
    runCount: number;
    expectedFail: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    /** `run-if` excluded. */
    skipCount: number;
}

/**
 * Counted by hand off the raw arrays, then written out.
 *
 * `test_socks.js` and `test_ipcshell.js` carry the fixture's only
 * `EXPECTED-FAIL` runs — 3,494 and 1,479 — which is what makes this fixture
 * able to tell the page's `computeTestStats` (which folds them into passes)
 * apart from `lib/query/issues.ts` (which names them). Both put them in
 * `runCount`, so the two agree on every displayed number; see the measurement
 * table at the top of `site/issues-view.ts`.
 *
 * `test_ext_always_green.js` has 500 runs and no issue at all — the clean test
 * that keeps `keepClean` honest.
 */
const TALLY: Tally[] = [
    { name: 'test_ext_geckoProfiler_control.js', component: 'WebExtensions :: General', runCount: 9078, expectedFail: 0, failCount: 0, timeoutCount: 0, crashCount: 3, skipCount: 7479 },
    { name: 'test_trr_https_fallback.js', component: 'Core :: Networking', runCount: 5772, expectedFail: 0, failCount: 8, timeoutCount: 0, crashCount: 0, skipCount: 7074 },
    { name: 'test_ext_background_early_shutdown.js', component: 'WebExtensions :: General', runCount: 15924, expectedFail: 0, failCount: 369, timeoutCount: 107, crashCount: 304, skipCount: 918 },
    { name: 'test_ext_dnr_dynamic_rules.js', component: 'WebExtensions :: General', runCount: 17376, expectedFail: 0, failCount: 857, timeoutCount: 445, crashCount: 1, skipCount: 0 },
    { name: 'test_ext_alarms.js', component: 'WebExtensions :: General', runCount: 21580, expectedFail: 0, failCount: 43, timeoutCount: 20, crashCount: 1, skipCount: 1348 },
    { name: 'test_ext_contentscript_context.js', component: 'WebExtensions :: General', runCount: 16697, expectedFail: 0, failCount: 268, timeoutCount: 862, crashCount: 2, skipCount: 968 },
    { name: 'test_ext_csp_upgrade_requests.js', component: 'WebExtensions :: General', runCount: 16318, expectedFail: 0, failCount: 10, timeoutCount: 212, crashCount: 5, skipCount: 0 },
    { name: 'test_socks.js', component: 'Core :: Networking', runCount: 12840, expectedFail: 3494, failCount: 0, timeoutCount: 1, crashCount: 0, skipCount: 0 },
    { name: 'test_ipcshell.js', component: 'Core :: XPConnect', runCount: 5893, expectedFail: 1479, failCount: 2, timeoutCount: 0, crashCount: 2, skipCount: 0 },
    { name: 'test_ext_always_green.js', component: 'WebExtensions :: General', runCount: 500, expectedFail: 0, failCount: 0, timeoutCount: 0, crashCount: 0, skipCount: 0 },
];

/**
 * Re-derives the tally from the fixture, touching no module under test.
 *
 * Deliberately open-coded against `tables.statuses` and `counts`, so that this
 * function and `lib/query/issues.ts` can only agree by both being right about
 * the file. A fixture replaced without updating `TALLY` fails the first test
 * below rather than quietly changing every expectation.
 */
function handTally(): Tally[] {
    const out: Tally[] = [];
    for (let testId = 0; testId < raw.testRuns.length; testId++) {
        const groups = raw.testRuns[testId]!;
        let pass = 0;
        let expectedFail = 0;
        let failCount = 0;
        let timeoutCount = 0;
        let crashCount = 0;
        let skipCount = 0;
        for (let statusId = 0; statusId < groups.length; statusId++) {
            const group = groups[statusId];
            if (!group) {
                continue;
            }
            const status = raw.tables.statuses[statusId]!;
            const total = group.counts.reduce((sum, count) => sum + count, 0);
            if (status === 'SKIP') {
                for (let i = 0; i < group.counts.length; i++) {
                    const messageId = group.messageIds?.[i];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : raw.tables.messages[messageId];
                    // `run-if` is scoped-elsewhere, not disabled.
                    if (message === null || message === undefined || !message.startsWith('run-if')) {
                        skipCount += group.counts[i]!;
                    }
                }
            } else if (status === 'EXPECTED-FAIL') {
                expectedFail += total;
            } else if (status.startsWith('PASS')) {
                pass += total;
            } else if (status.startsWith('TIMEOUT')) {
                timeoutCount += total;
            } else if (status === 'CRASH') {
                crashCount += total;
            } else {
                failCount += total;
            }
        }
        const componentId = raw.testInfo.componentIds?.[testId];
        out.push({
            name: raw.tables.testNames[raw.testInfo.testNameIds[testId]!]!,
            component:
                componentId === null || componentId === undefined
                    ? NO_COMPONENT
                    : raw.tables.components[componentId]!,
            runCount: pass + expectedFail + failCount + timeoutCount + crashCount,
            expectedFail,
            failCount,
            timeoutCount,
            crashCount,
            skipCount,
        });
    }
    return out;
}

test('the hand tally still matches the fixture', () => {
    // The guard that makes every literal below trustworthy. Without it, a
    // fixture swap would leave the expectations describing a file that is no
    // longer there, and the suite would go on passing against stale numbers.
    assert.deepEqual(handTally(), TALLY);
});

test('the fixture has the properties the tests below rely on', () => {
    // Each of these is a discriminating case. If the fixture lost one, the
    // test that depends on it would still pass while checking nothing, so the
    // preconditions are asserted rather than assumed.
    assert.ok(
        TALLY.some((row) => row.expectedFail > 0),
        'need EXPECTED-FAIL runs, or the runCount definition cannot be told from a pass-only one'
    );
    assert.ok(
        TALLY.some((row) => issueOf(row, ALL_FILTERS) === 0),
        'need a clean test, or `keepClean` and the "(N tests)" header cannot be exercised'
    );
    assert.ok(
        TALLY.some((row) => row.skipCount > 0) && TALLY.some((row) => row.skipCount === 0),
        'need both skipped and unskipped tests to see the denominator move'
    );
    assert.equal(new Set(TALLY.map((row) => row.component)).size, 3, 'three components');
});

/** The issue count of a hand-tallied row under a filter setting. */
function issueOf(row: Tally, filters: IssueFilters): number {
    return (
        (filters.skips ? row.skipCount : 0) +
        (filters.failures ? row.failCount : 0) +
        (filters.timeouts ? row.timeoutCount : 0) +
        (filters.crashes ? row.crashCount : 0)
    );
}

/** The component totals, from the hand tally alone. */
function handGroups(filters: IssueFilters): Map<
    string,
    { runCount: number; skipCount: number; failCount: number; timeoutCount: number; crashCount: number; issueCount: number; tests: number; withIssues: number }
> {
    const groups = new Map<string, ReturnType<typeof handGroups> extends Map<string, infer V> ? V : never>();
    for (const row of TALLY) {
        let group = groups.get(row.component);
        if (group === undefined) {
            group = { runCount: 0, skipCount: 0, failCount: 0, timeoutCount: 0, crashCount: 0, issueCount: 0, tests: 0, withIssues: 0 };
            groups.set(row.component, group);
        }
        group.runCount += row.runCount;
        group.skipCount += row.skipCount;
        group.failCount += row.failCount;
        group.timeoutCount += row.timeoutCount;
        group.crashCount += row.crashCount;
        group.tests += 1;
        if (issueOf(row, filters) > 0) {
            group.withIssues += 1;
        }
    }
    for (const group of groups.values()) {
        group.issueCount =
            (filters.skips ? group.skipCount : 0) +
            (filters.failures ? group.failCount : 0) +
            (filters.timeouts ? group.timeoutCount : 0) +
            (filters.crashes ? group.crashCount : 0);
    }
    return groups;
}

// =========================================================================
// The component rows
// =========================================================================

test('a component row totals every test in it, clean ones included', () => {
    // The order-of-operations rule the CLI needed `keepClean` for
    // (`old/issues.html:2007-2013` runs before the `:2016` gate). The
    // discriminating case is `WebExtensions :: General`, which holds the
    // 500-run clean test: an implementation that summed only the tests it was
    // going to *list* would report 96,973 runs instead of 97,473, and the
    // rate would move with it.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const expected = handGroups(ALL_FILTERS);

    assert.equal(rows.length, expected.size);
    for (const row of rows) {
        const want = expected.get(row.key);
        assert.ok(want !== undefined, `unexpected component ${row.key}`);
        assert.equal(row.stats.runCount, want.runCount, `${row.key} runCount`);
        assert.equal(row.stats.skipCount, want.skipCount, `${row.key} skipCount`);
        assert.equal(row.stats.failCount, want.failCount, `${row.key} failCount`);
        assert.equal(row.stats.timeoutCount, want.timeoutCount, `${row.key} timeoutCount`);
        assert.equal(row.stats.crashCount, want.crashCount, `${row.key} crashCount`);
        assert.equal(row.stats.issueCount, want.issueCount, `${row.key} issueCount`);
        assert.equal(row.totalTestCount, want.tests, `${row.key} totalTestCount`);
        assert.equal(row.tests.length, want.withIssues, `${row.key} tests with issues`);
    }

    // Stated as a literal too, so that a change to `handGroups` cannot move
    // the expectation and the assertion together.
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    assert.equal(web.stats.runCount, 97473);
    assert.equal(web.totalTestCount, 7);
    assert.equal(web.tests.length, 6, 'six of the seven have an issue; test_ext_always_green has none');
});

test('a test with no issue is never listed as a child row', () => {
    // The `:2016` / `:2160` gate. The clean test must be in the denominator
    // and out of the list, and asserting only the second half would pass for
    // an implementation that dropped it from both.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const listed = web.tests.map((test) => test.fullPath);
    assert.ok(
        !listed.some((path) => path.endsWith('test_ext_always_green.js')),
        'a test with no issue must not be a child row'
    );
    assert.equal(web.totalTestCount, 7, 'but it must still be counted in the population');
    assert.ok(
        web.stats.runCount > web.tests.reduce((sum, test) => sum + test.runCount, 0),
        'and its runs must be inside the component total'
    );
});

test('a component whose every test is clean is still a row', () => {
    // `old/issues.html:2111-2112` renders it as `(N tests)`. `lib/query/issues.ts`
    // drops it (`:329`), so this is the page keeping something the CLI does
    // not — a declared page-vs-CLI divergence, and the reason
    // `buildComponentRows` has an `emptyGroup` path at all.
    //
    // Reached by turning every filter off, which makes *all* three components
    // clean: with no type counted, nothing is an issue.
    const none: IssueFilters = { failures: false, timeouts: false, crashes: false, skips: false };
    const rows = buildComponentRows(file, none, '');
    assert.equal(rows.length, 3, 'all three components survive with no types enabled');
    for (const row of rows) {
        assert.equal(row.tests.length, 0, `${row.key} lists no tests`);
        assert.equal(row.stats.issueCount, 0, `${row.key} counts no issues`);
        // The counters that do not depend on the enabled types must survive,
        // or the row would render as an empty shell.
        assert.ok(row.stats.runCount > 0, `${row.key} keeps its run total`);
        assert.equal(row.stats.issueRate, 0);
    }
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    assert.equal(web.stats.runCount, 97473, 'the run total is the same one the enabled view shows');
    assert.equal(web.totalTestCount, 7);
});

// =========================================================================
// The filters change numbers, not visibility
// =========================================================================

test('unchecking skips moves both the numerator and the denominator', () => {
    // The property the whole page turns on (`:1071-1078`). A denominator that
    // kept the skips while the numerator dropped them would report
    // WebExtensions at 3,509/108,186 = 3.24% instead of 3,509/97,473 = 3.60%,
    // and both are plausible-looking numbers — which is why the rate is
    // asserted and not just the count.
    const noSkips: IssueFilters = { ...ALL_FILTERS, skips: false };
    const rows = buildComponentRows(file, noSkips, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;

    assert.equal(web.stats.issueCount, 3509, 'fail + timeout + crash only');
    assert.equal(web.stats.skipCount, 10713, 'the skips are still counted and displayed');
    // 3509 / 97473, the runs alone — no skips added back.
    assert.equal(web.stats.issueRate, (3509 / 97473) * 100);
    assert.notEqual(
        web.stats.issueRate,
        (3509 / (97473 + 10713)) * 100,
        'the skipped runs must leave the denominator with the numerator'
    );

    // With skips on it is the other denominator, asserted from the literal.
    const withSkips = buildComponentRows(file, ALL_FILTERS, '').find(
        (row) => row.key === 'WebExtensions :: General'
    )!;
    assert.equal(withSkips.stats.issueCount, 14222);
    assert.equal(withSkips.stats.issueRate, (14222 / (97473 + 10713)) * 100);
});

test('a filter changes which tests are listed, because a test needs an issue of an enabled type', () => {
    // `test_ext_geckoProfiler_control.js` has 7,479 skips and 3 crashes and no
    // failures or timeouts. With only failures counted it has no issue, so it
    // must leave the list — while staying in the component's population.
    const failuresOnly: IssueFilters = {
        failures: true,
        timeouts: false,
        crashes: false,
        skips: false,
    };
    const rows = buildComponentRows(file, failuresOnly, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const listed = web.tests.map((test) => test.fullPath);

    assert.ok(
        !listed.some((path) => path.endsWith('test_ext_geckoProfiler_control.js')),
        'a skip-and-crash-only test is not an issue when only failures count'
    );
    assert.ok(
        listed.some((path) => path.endsWith('test_ext_dnr_dynamic_rules.js')),
        'a test with 857 failures still is'
    );
    assert.equal(web.totalTestCount, 7, 'the population does not shrink');
    assert.equal(web.stats.runCount, 97473, 'and neither does the denominator');
});

test('typesOf maps the page vocabulary onto the library one', () => {
    // The one place `failures` becomes `fail`. A mapping that dropped a type
    // would silently narrow what the CLI and the page each count.
    assert.deepEqual(typesOf(ALL_FILTERS), ['fail', 'timeout', 'crash', 'skip']);
    assert.deepEqual(typesOf({ ...ALL_FILTERS, skips: false }), ['fail', 'timeout', 'crash']);
    assert.deepEqual(
        typesOf({ failures: false, timeouts: false, crashes: false, skips: false }),
        []
    );
    assert.deepEqual(
        typesOf({ failures: false, timeouts: true, crashes: false, skips: true }),
        ['timeout', 'skip']
    );
});

// =========================================================================
// Sorting
// =========================================================================

test('the default sort is issues, descending', () => {
    assert.deepEqual(INITIAL_SORT, { field: 'issueCount', direction: 'desc' });
    const rows = sortComponents(
        buildComponentRows(file, ALL_FILTERS, ''),
        INITIAL_SORT,
        ALL_FILTERS
    );
    // From the hand tally: WebExtensions 14,222 > Networking 7,083 > XPConnect 4.
    assert.deepEqual(
        rows.map((row) => row.key),
        ['WebExtensions :: General', 'Core :: Networking', 'Core :: XPConnect']
    );
    assert.deepEqual(
        rows.map((row) => row.stats.issueCount),
        [14222, 7083, 4]
    );
});

test('every column sorts, and each has the page default direction', () => {
    // `changeSortOrder` (`:1187-1200`): a new column starts descending except
    // `name` and `issuePercentage`. Asserted per column rather than in bulk,
    // because the exception is exactly the kind of thing a rewrite drops.
    for (const [field] of STAT_COLUMNS) {
        const expected = field === 'issuePercentage' ? 'asc' : 'desc';
        assert.equal(
            nextSort({ field: 'runCount', direction: 'desc' }, field).direction,
            field === 'runCount' ? 'asc' : expected,
            `${field} default direction`
        );
    }
    assert.equal(nextSort({ field: 'issueCount', direction: 'desc' }, 'name').direction, 'asc');
    // The same column flips.
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'desc' }, 'issueCount'), {
        field: 'issueCount',
        direction: 'asc',
    });
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'asc' }, 'issueCount'), {
        field: 'issueCount',
        direction: 'desc',
    });
});

test('each column actually orders by its own quantity', () => {
    // A comparator that ignored its field and always used issueCount would
    // pass a "is it sorted?" check on the default column alone, so every
    // column is checked against the hand tally's own ordering.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const expected: Record<string, string[]> = {
        // runs: WebExt 97,473 > Networking 18,612 > XPConnect 5,893
        runCount: ['WebExtensions :: General', 'Core :: Networking', 'Core :: XPConnect'],
        // skips: Networking 7,074 > WebExt 10,713? no — WebExt 10,713 > 7,074 > 0
        skipCount: ['WebExtensions :: General', 'Core :: Networking', 'Core :: XPConnect'],
        // failures: WebExt 1,547 > Networking 8 > XPConnect 2
        failCount: ['WebExtensions :: General', 'Core :: Networking', 'Core :: XPConnect'],
        // timeouts: WebExt 1,646 > Networking 1 > XPConnect 0
        timeoutCount: ['WebExtensions :: General', 'Core :: Networking', 'Core :: XPConnect'],
        // crashes: WebExt 316 > XPConnect 2 > Networking 0 — a different order
        crashCount: ['WebExtensions :: General', 'Core :: XPConnect', 'Core :: Networking'],
        // rate ascending: XPConnect 0.068% < WebExt 13.15% < Networking 27.58%
        issuePercentage: ['Core :: XPConnect', 'WebExtensions :: General', 'Core :: Networking'],
    };
    for (const [field, order] of Object.entries(expected)) {
        const direction = field === 'issuePercentage' ? 'asc' : 'desc';
        const sorted = sortComponents(
            rows,
            { field: field as never, direction },
            ALL_FILTERS
        );
        assert.deepEqual(sorted.map((row) => row.key), order, `sorted by ${field} ${direction}`);
    }
    // `crashCount` is the discriminating one: it is the only column whose
    // order differs from `issueCount`'s, so a comparator stuck on the default
    // field fails here and nowhere else.
    assert.notDeepEqual(expected['crashCount'], expected['runCount']);
});

test('sorting by name uses the component name, both directions', () => {
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    assert.deepEqual(
        sortComponents(rows, { field: 'name', direction: 'asc' }, ALL_FILTERS).map((row) => row.key),
        ['Core :: Networking', 'Core :: XPConnect', 'WebExtensions :: General']
    );
    assert.deepEqual(
        sortComponents(rows, { field: 'name', direction: 'desc' }, ALL_FILTERS).map((row) => row.key),
        ['WebExtensions :: General', 'Core :: XPConnect', 'Core :: Networking']
    );
});

test('the rate sort uses the exact ratio, not the displayed percentage', () => {
    // `old/issues.html:2046` sorts on `issueCount / totalCount` — unrounded. Two
    // components that both display the same rounded percentage must still
    // order by their real rates.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const byRate = sortComponents(rows, { field: 'issuePercentage', direction: 'asc' }, ALL_FILTERS);
    const xpconnect = byRate.find((row) => row.key === 'Core :: XPConnect')!;
    // 4 / 5,893 = 0.0679%, which displays as `<1%` and rounds to 0.
    assert.equal(percentageDisplay(xpconnect.stats, ALL_FILTERS).displayValue, '<1%');
    assert.equal(byRate[0]!.key, 'Core :: XPConnect', 'the smallest exact rate sorts first');
    assert.ok(xpconnect.stats.issueRate > 0, 'and it is genuinely non-zero');

    // The discriminating case, which the fixture's three components cannot
    // supply: two rows whose rates round to the same integer. A mutation
    // making the comparator sort on `Math.round(rate * 100)` survived the
    // assertions above, because all three fixture components round apart
    // (0, 13, 28). It matters at real scale — measured on the pinned 21-day
    // xpcshell file, 136 components collapse to **22 distinct rounded rates,
    // with 129 of the 136 sharing a rounded rate with another component** — so
    // a rounding comparator would leave nearly every row in insertion order.
    //
    // Built here rather than measured off a file, so the property is asserted
    // rather than the fixture: two synthetic rows, 5.2% and 5.4%, which both
    // round to and display `5%` while being genuinely different rates.
    const near: ComponentRowLike[] = [
        synthetic('A :: Low', { issueCount: 52, runCount: 1000 }),
        synthetic('B :: High', { issueCount: 54, runCount: 1000 }),
    ];
    assert.equal(
        percentageDisplay(near[0]!.stats, ALL_FILTERS).displayValue,
        percentageDisplay(near[1]!.stats, ALL_FILTERS).displayValue,
        'the two must display the same percentage, or the case is not discriminating'
    );
    const ascending = sortComponents(near as never, { field: 'issuePercentage', direction: 'asc' }, ALL_FILTERS);
    assert.deepEqual(
        ascending.map((row) => row.key),
        ['A :: Low', 'B :: High'],
        'the lower exact rate sorts first even though both display 5%'
    );
    const descending = sortComponents(near as never, { field: 'issuePercentage', direction: 'desc' }, ALL_FILTERS);
    assert.deepEqual(
        descending.map((row) => row.key),
        ['B :: High', 'A :: Low'],
        'and the order really reverses, so this is not passing on insertion order'
    );
});

/** The shape `sortComponents` reads, for the synthetic rows above. */
interface ComponentRowLike {
    key: string;
    stats: { issueCount: number; runCount: number; skipCount: number };
    tests: never[];
    matchingTestCount: number;
    totalTestCount: number;
    totalTestsWithIssues: number;
}

function synthetic(
    key: string,
    counts: { issueCount: number; runCount: number }
): ComponentRowLike {
    return {
        key,
        stats: { ...counts, skipCount: 0 },
        tests: [],
        matchingTestCount: 1,
        totalTestCount: 1,
        totalTestsWithIssues: 1,
    };
}

test('tests inside a component sort by the same field', () => {
    // `sortTestList` (`:1880`). The child rows re-sort with the parent's
    // field, so clicking "Failures" reorders both levels.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;

    const byFailures = sortTests(web.tests, { field: 'failCount', direction: 'desc' });
    assert.deepEqual(
        byFailures.map((test) => test.failCount),
        [857, 369, 268, 43, 10, 0],
        'from the hand tally, the six listed WebExtensions tests by failures'
    );

    const bySkips = sortTests(web.tests, { field: 'skipCount', direction: 'desc' });
    assert.equal(bySkips[0]!.skipCount, 7479, 'geckoProfiler_control has the most skips');
    assert.notEqual(
        bySkips[0]!.fullPath,
        byFailures[0]!.fullPath,
        'the two columns must not produce the same first row, or this asserts nothing'
    );

    const byName = sortTests(web.tests, { field: 'name', direction: 'asc' });
    assert.deepEqual(
        byName.map((test) => test.fullPath),
        [...byName.map((test) => test.fullPath)].sort((a, b) => a.localeCompare(b))
    );
});

// =========================================================================
// The search
// =========================================================================

test('a search on a component name keeps that component and drops the others', () => {
    // Both halves. An implementation with the filter deleted passes "the
    // component survives" and fails "the others are gone" — which is the trap
    // an earlier test in this repo fell into.
    const rows = buildComponentRows(file, ALL_FILTERS, 'networking');
    assert.deepEqual(rows.map((row) => row.key), ['Core :: Networking']);

    // And matching on the component keeps *every* test in it, including the
    // ones whose own paths say nothing about networking.
    const networking = rows[0]!;
    assert.equal(networking.tests.length, 2, 'both Networking tests survive a component match');
    assert.equal(networking.matchingTestCount, 2);
});

test('a search on a test path keeps only the matching tests', () => {
    // `test_socks.js` is one of the two Networking tests. Searching for it
    // must keep its component with one test, and drop the other component
    // entirely.
    const rows = buildComponentRows(file, ALL_FILTERS, 'test_socks');
    assert.deepEqual(rows.map((row) => row.key), ['Core :: Networking']);
    const networking = rows[0]!;
    assert.equal(networking.matchingTestCount, 1, 'only the matching test is kept');
    assert.deepEqual(
        networking.tests.map((test) => test.fullPath),
        ['netwerk/test/unit/test_socks.js']
    );
    // The component's numbers are recomputed over the kept test alone: 12,840
    // runs, not the 18,612 the whole component has.
    assert.equal(networking.stats.runCount, 12840);
    assert.notEqual(networking.stats.runCount, 18612, 'a search must narrow the row, not just the list');
});

test('a search matching nothing produces no rows', () => {
    assert.deepEqual(buildComponentRows(file, ALL_FILTERS, 'zzz-no-such-test'), []);
});

test('a search is case-insensitive on both the component and the path', () => {
    assert.equal(buildComponentRows(file, ALL_FILTERS, 'NETWORKING').length, 1);
    assert.equal(buildComponentRows(file, ALL_FILTERS, 'TEST_SOCKS').length, 1);
});

test('a component whose only matching tests are clean is dropped', () => {
    // `old/issues.html:2024-2029`: with a search, a component survives if its name
    // matched *or* it kept a test with an issue. `test_ext_always_green.js`
    // matches on path, has no issue, and its component name does not contain
    // the term — so the row goes.
    const rows = buildComponentRows(file, ALL_FILTERS, 'always_green');
    assert.deepEqual(rows, [], 'a matching but issue-free test is not a reason to show a row');
});

test('a component whose NAME matches survives even with no issues to show', () => {
    // The other half of the same rule, and the half that needs a specific
    // setup to reach: with every filter off no test has an issue, so the
    // name match is the *only* thing that can keep a row. A mutation dropping
    // `row.key.toLowerCase().includes(needle)` from the survive condition
    // passed the whole suite without this.
    const none: IssueFilters = { failures: false, timeouts: false, crashes: false, skips: false };
    const rows = buildComponentRows(file, none, 'xpconnect');
    assert.deepEqual(
        rows.map((row) => row.key),
        ['Core :: XPConnect'],
        'the component is kept because its name matched, not because of its tests'
    );
    assert.equal(rows[0]!.tests.length, 0, 'and it really has no test to list');
    // The contrast: a term matching no component name and no test path keeps
    // nothing, so the rule above is a match rather than a blanket keep.
    assert.deepEqual(buildComponentRows(file, none, 'zzz-no-such-thing'), []);
});

// =========================================================================
// The three view modes
// =========================================================================

test('the fixture can tell the component grouping from the directory grouping', () => {
    // The precondition this section needs stated rather than assumed, because
    // it is a near-miss: the fixture's three directories map **one to one**
    // onto its three components, so the two groupings produce the same number
    // of rows with the same members and therefore the same counters. Only the
    // *keys* differ. Every assertion below is written on keys for that reason,
    // and a test asserting only counts would pass with the grouping ignored.
    const byComponent = new Set(TALLY.map((row) => row.component));
    const byDirectory = new Set(handDirectories().values());
    assert.equal(byComponent.size, 3);
    assert.equal(byDirectory.size, 3);
    assert.equal(
        [...byComponent].filter((key) => byDirectory.has(key)).length,
        0,
        'no component name is also a directory, so a key alone says which grouping ran'
    );
});

/** Each test's directory, read off the raw fixture arrays. */
function handDirectories(): Map<string, string> {
    const out = new Map<string, string>();
    for (let testId = 0; testId < raw.testRuns.length; testId++) {
        out.set(
            raw.tables.testNames[raw.testInfo.testNameIds[testId]!]!,
            raw.tables.testPaths[raw.testInfo.testPathIds[testId]!]!
        );
    }
    return out;
}

test('the tree mode groups by directory, with the same counters', () => {
    const tree = buildComponentRows(file, ALL_FILTERS, '', 'directory');
    assert.deepEqual(
        tree.map((row) => row.key).sort(),
        ['ipc/testshell/tests', 'netwerk/test/unit', 'toolkit/components/extensions/test/xpcshell'],
        'the keys are the test paths from `tables.testPaths`, not component names'
    );

    // The directory totals, tallied by hand off `TALLY` and the raw paths, so
    // the expectation is not `groupIssues`' own output.
    const directories = handDirectories();
    const expected = new Map<string, { runCount: number; issueCount: number; tests: number }>();
    for (const row of TALLY) {
        const key = directories.get(row.name)!;
        const group = expected.get(key) ?? { runCount: 0, issueCount: 0, tests: 0 };
        group.runCount += row.runCount;
        group.issueCount += issueOf(row, ALL_FILTERS);
        group.tests += 1;
        expected.set(key, group);
    }
    for (const row of tree) {
        const want = expected.get(row.key)!;
        assert.equal(row.stats.runCount, want.runCount, `${row.key} runCount`);
        assert.equal(row.stats.issueCount, want.issueCount, `${row.key} issueCount`);
        assert.equal(row.totalTestCount, want.tests, `${row.key} totalTestCount`);
    }
});

test('the tree mode keeps a directory whose tests are all clean', () => {
    // The same `keepClean` rule the components view has, on the other key:
    // with every filter off nothing has an issue, and all three directories
    // must still be rows with their whole populations in the denominator. A
    // `groupBy` that fell back to the component path would produce component
    // keys here and fail on the first assertion.
    const none: IssueFilters = { failures: false, timeouts: false, crashes: false, skips: false };
    const tree = buildComponentRows(file, none, '', 'directory');
    assert.deepEqual(
        tree.map((row) => row.key).sort(),
        ['ipc/testshell/tests', 'netwerk/test/unit', 'toolkit/components/extensions/test/xpcshell']
    );
    for (const row of tree) {
        assert.equal(row.tests.length, 0, `${row.key} has nothing to list`);
        assert.ok(row.stats.runCount > 0, `${row.key} still counts its runs`);
        assert.equal(row.stats.issueCount, 0);
    }
});

test('a search in the tree mode matches the directory or the test path', () => {
    // `matchesSearch` compares the *key*, so in this mode that is the
    // directory — searching `netwerk` keeps a row whose test paths do not
    // contain the term in their file names.
    const rows = buildComponentRows(file, ALL_FILTERS, 'netwerk', 'directory');
    assert.deepEqual(
        rows.map((row) => row.key),
        ['netwerk/test/unit']
    );
    assert.equal(rows[0]!.matchingTestCount, 2, 'both of its tests are kept by the key match');
    // And the path half of the same rule, which narrows within a directory.
    const narrowed = buildComponentRows(file, ALL_FILTERS, 'test_socks', 'directory');
    assert.deepEqual(
        narrowed.map((row) => row.key),
        ['netwerk/test/unit']
    );
    assert.equal(narrowed[0]!.matchingTestCount, 1);
});

test('the default grouping is component, so an existing caller is unchanged', () => {
    // The parameter is additive: three arguments must still mean what they
    // meant before the view control existed. A mutation defaulting it to
    // `directory` would fail here and nowhere else, because every other call
    // in this file passes three arguments too.
    assert.deepEqual(
        buildComponentRows(file, ALL_FILTERS, ''),
        buildComponentRows(file, ALL_FILTERS, '', 'component')
    );
    assert.deepEqual(
        buildComponentRows(file, ALL_FILTERS, '').map((row) => row.key).sort(),
        ['Core :: Networking', 'Core :: XPConnect', 'WebExtensions :: General']
    );
});

test('the list mode is one row per test with an issue, clean tests dropped', () => {
    const rows = buildTestRows(file, ALL_FILTERS, '');
    const withIssues = TALLY.filter((row) => issueOf(row, ALL_FILTERS) > 0);
    assert.deepEqual(
        rows.map((row) => row.fullPath.split('/').pop()!).sort(),
        withIssues.map((row) => row.name).sort()
    );
    // The discriminating case, and the difference from both grouped modes:
    // `test_ext_always_green.js` has 500 runs and no issue. The grouped modes
    // count it into a denominator; here it is not a row at all, which is
    // `fx-tests issues --group-by test` (`cli/commands/issues.ts:420-422`).
    assert.ok(
        TALLY.some((row) => row.name === 'test_ext_always_green.js' && issueOf(row, ALL_FILTERS) === 0),
        'the fixture still has the clean test this distinction needs'
    );
    assert.equal(
        rows.filter((row) => row.fullPath.endsWith('test_ext_always_green.js')).length,
        0
    );

    // The counters are the per-test ones, unchanged from the child rows the
    // grouped modes render — checked on the one test whose numbers are the
    // most distinctive in the fixture.
    const dnr = rows.find((row) => row.fullPath.endsWith('test_ext_dnr_dynamic_rules.js'))!;
    const want = TALLY.find((row) => row.name === 'test_ext_dnr_dynamic_rules.js')!;
    assert.equal(dnr.runCount, want.runCount);
    assert.equal(dnr.failCount, want.failCount);
    assert.equal(dnr.timeoutCount, want.timeoutCount);
    assert.equal(dnr.crashCount, want.crashCount);
    assert.equal(dnr.skipCount, want.skipCount);
    assert.equal(dnr.issueCount, issueOf(want, ALL_FILTERS));
});

test('the list mode follows the filters, in both directions', () => {
    // The checkboxes change which tests are rows at all, because a test is a
    // row only when it has an issue of an enabled type. `test_socks.js` has
    // one timeout and nothing else, so it appears under timeouts and vanishes
    // without them — a mutation ignoring `filters` here keeps it in both.
    const timeoutsOnly: IssueFilters = { failures: false, timeouts: true, crashes: false, skips: false };
    const withTimeouts = buildTestRows(file, timeoutsOnly, '');
    assert.ok(withTimeouts.some((row) => row.fullPath.endsWith('test_socks.js')));

    const failuresOnly: IssueFilters = { failures: true, timeouts: false, crashes: false, skips: false };
    const withoutTimeouts = buildTestRows(file, failuresOnly, '');
    assert.ok(
        !withoutTimeouts.some((row) => row.fullPath.endsWith('test_socks.js')),
        'its only issue is a timeout, so it is not a row when timeouts are off'
    );

    const none: IssueFilters = { failures: false, timeouts: false, crashes: false, skips: false };
    assert.deepEqual(buildTestRows(file, none, ''), [], 'no enabled type means no row');
});

test('the list mode searches the test path only, not the component', () => {
    // The one place the list deliberately differs from the grouped modes'
    // search. `WebExtensions` matches seven tests through their *component* in
    // the components view; with no group row to keep, matching on it here
    // would list tests whose own paths never mention extensions.
    assert.equal(
        buildComponentRows(file, ALL_FILTERS, 'webextensions').length,
        1,
        'the grouped mode keeps the component by name'
    );
    assert.deepEqual(
        buildTestRows(file, ALL_FILTERS, 'webextensions'),
        [],
        'no test path contains it, so the list keeps nothing'
    );
    // And the path match itself still works, case-insensitively.
    assert.equal(buildTestRows(file, ALL_FILTERS, 'TEST_SOCKS').length, 1);
    assert.equal(buildTestRows(file, ALL_FILTERS, 'netwerk').length, 2);
});

test('a mode maps to the grouping the CLI uses, and the default is components', () => {
    assert.equal(DEFAULT_VIEW, 'components');
    assert.equal(groupingOf('components'), 'component');
    assert.equal(groupingOf('tree'), 'directory');
    assert.equal(groupingOf('list'), null, 'the flat list has no grouping key');
    // The radios, by id and label, as the markup carries them.
    assert.deepEqual(VIEW_MODES, [
        ['components', 'view-components', 'bugzilla components'],
        ['tree', 'view-tree', 'source tree'],
        ['list', 'view-list', 'list'],
    ]);
    assert.equal(VIEW_MODES[0]![0], DEFAULT_VIEW, 'the default is the first radio');
});

test('component availability decides whether the components mode is usable', () => {
    // `hasComponentData` on a file that has them, which both fixtures do.
    assert.equal(hasComponentData(file), true);
    assert.equal(effectiveView('components', file), 'components');
    assert.equal(effectiveView('tree', file), 'tree');
    assert.equal(effectiveView('list', file), 'list');

    // And on one that does not. Built by dropping `tables.components` from a
    // copy of the fixture, which is exactly what the optional field being
    // absent means (`lib/formats/tables.ts:105`) — `readTest` then returns
    // `component: null` for every test, so the components view would collapse
    // to a single `(no component)` row.
    const stripped = structuredClone(raw);
    // `IssuesTables.components` is declared required, so the cast is what lets
    // the field be removed — which is the state the *format* permits
    // (`TestInfoTables.components` is optional) and a published file could
    // arrive in.
    delete (stripped.tables as { components?: string[] }).components;
    const noComponents = decodeIssues(stripped);
    assert.equal(hasComponentData(noComponents), false);
    assert.equal(
        effectiveView('components', noComponents),
        'tree',
        'the fallback `xpcshell-timings.html:3055-3060` applies'
    );
    // The other two are unaffected: neither needs a component.
    assert.equal(effectiveView('tree', noComponents), 'tree');
    assert.equal(effectiveView('list', noComponents), 'list');
    // With no file loaded there is nothing to ask, so the selection stands.
    assert.equal(effectiveView('components', null), 'components');

    // The collapse this guards against, measured rather than asserted about:
    // grouping that file by component really does give one row.
    const collapsed = buildComponentRows(noComponents, ALL_FILTERS, '', 'component');
    assert.deepEqual(
        collapsed.map((row) => row.key),
        [NO_COMPONENT]
    );
});

test('isViewMode accepts the three and nothing else', () => {
    assert.equal(isViewMode('components'), true);
    assert.equal(isViewMode('tree'), true);
    assert.equal(isViewMode('list'), true);
    assert.equal(isViewMode('component'), false, 'the CLI spelling is not a mode');
    assert.equal(isViewMode('directory'), false);
    assert.equal(isViewMode(''), false);
    assert.equal(isViewMode(undefined), false);
});

// =========================================================================
// The component header
// =========================================================================

test('the header counts have three shapes', () => {
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const xpconnect = rows.find((row) => row.key === 'Core :: XPConnect')!;

    // Some have issues and some do not → `out of` the population.
    assert.deepEqual(headerCounts(web, ''), { withIssues: 6, outOf: 7 });
    // Every test has an issue → no `out of`, because `1 of 1` says nothing.
    assert.deepEqual(headerCounts(xpconnect, ''), { withIssues: 1, outOf: null });

    // None has an issue → the `(N tests)` shape, signalled by withIssues 0.
    const none: IssueFilters = { failures: false, timeouts: false, crashes: false, skips: false };
    const clean = buildComponentRows(file, none, '').find(
        (row) => row.key === 'Core :: XPConnect'
    )!;
    assert.deepEqual(headerCounts(clean, ''), { withIssues: 0, outOf: 1 });
});

test('a search that narrows a component changes the "out of" to the matching count', () => {
    // `:2102-2103`. Searching one test in a two-test component must read
    // `1 test with issues` rather than `out of 2` — the reader is being told
    // about what they filtered to, not about the whole component.
    const rows = buildComponentRows(file, ALL_FILTERS, 'test_socks');
    const networking = rows[0]!;
    assert.equal(networking.totalTestCount, 2, 'the component really does have two tests');
    assert.equal(networking.matchingTestCount, 1);
    // 1 with issues out of 1 matching → no `out of` at all.
    assert.deepEqual(headerCounts(networking, 'test_socks'), { withIssues: 1, outOf: null });
    // Without the search it would have said `out of 2`.
    assert.deepEqual(headerCounts(networking, ''), { withIssues: 1, outOf: 2 });
});

// =========================================================================
// The Issue% cell
// =========================================================================

test('the percentage bands and their colours', () => {
    // `getIssuePercentageDisplay` (`:774-802`). The bands are on the rounded
    // value and the `<1%` test is on the exact one, so the boundary cases are
    // what distinguish a correct implementation from one that rounds twice or
    // tests the wrong quantity.
    const at = (issueCount: number, runCount: number): ReturnType<typeof percentageDisplay> =>
        percentageDisplay({ issueCount, runCount, skipCount: 0 }, { ...ALL_FILTERS, skips: false });

    assert.deepEqual(at(0, 0), { displayValue: '0%', cssClass: 'zero' }, 'no runs');
    assert.deepEqual(at(0, 100), { displayValue: '0%', cssClass: 'zero' }, 'exactly zero');
    assert.deepEqual(at(1, 1000), { displayValue: '<1%', cssClass: '' }, '0.1%');
    assert.deepEqual(at(99, 10000), { displayValue: '<1%', cssClass: '' }, '0.99% is still <1%');
    assert.deepEqual(at(1, 100), { displayValue: '1%', cssClass: '' }, 'exactly 1%');
    assert.deepEqual(at(2, 100), { displayValue: '2%', cssClass: 'yellow' });
    assert.deepEqual(at(9, 100), { displayValue: '9%', cssClass: 'yellow' });
    assert.deepEqual(at(10, 100), { displayValue: '10%', cssClass: 'orange' });
    assert.deepEqual(at(19, 100), { displayValue: '19%', cssClass: 'orange' });
    assert.deepEqual(at(20, 100), { displayValue: '20%', cssClass: 'fail' });
    assert.deepEqual(at(100, 100), { displayValue: '100%', cssClass: 'fail' });

    // The rounding boundaries. 9.5% rounds to 10 and crosses into orange;
    // 19.5% rounds to 20 and crosses into fail. An implementation that
    // truncated instead of rounding gets both wrong.
    assert.deepEqual(at(95, 1000), { displayValue: '10%', cssClass: 'orange' }, '9.5% rounds up');
    assert.deepEqual(at(94, 1000), { displayValue: '9%', cssClass: 'yellow' }, '9.4% rounds down');
    assert.deepEqual(at(195, 1000), { displayValue: '20%', cssClass: 'fail' }, '19.5% rounds up');
});

test('the percentage rounds once, from the raw ratio', () => {
    // The double-round that shipped `14.37%` where a page showed `14.38%` on
    // an earlier migration. Here the observable is the band: 1,437 of 10,000
    // is 14.37%, which must round to 14 — and any intermediate rounding of the
    // ratio before scaling produces 0% instead.
    assert.deepEqual(
        percentageDisplay({ issueCount: 1437, runCount: 10000, skipCount: 0 }, { ...ALL_FILTERS, skips: false }),
        { displayValue: '14%', cssClass: 'orange' }
    );
    // And the real component, whose exact rate is 13.1458…%.
    const web = buildComponentRows(file, ALL_FILTERS, '').find(
        (row) => row.key === 'WebExtensions :: General'
    )!;
    assert.equal(web.stats.issueRate, (14222 / 108186) * 100);
    assert.deepEqual(percentageDisplay(web.stats, ALL_FILTERS), {
        displayValue: '13%',
        cssClass: 'orange',
    });
});

test('the Issue% denominator adds skips back exactly when they are counted', () => {
    // The denominator decision, asserted directly. Same numerator both ways,
    // and the two denominators differ by exactly the skip count.
    const stats = { issueCount: 50, runCount: 100, skipCount: 50 };
    assert.deepEqual(percentageDisplay(stats, ALL_FILTERS), {
        displayValue: '33%',
        cssClass: 'fail',
    }, '50 / (100 + 50)');
    assert.deepEqual(percentageDisplay(stats, { ...ALL_FILTERS, skips: false }), {
        displayValue: '50%',
        cssClass: 'fail',
    }, '50 / 100 — skips out of both, so the numerator is the caller\'s problem');
});

// =========================================================================
// The expanded test's issue list
// =========================================================================

test('an expanded test lists its issues, count-descending, then filtered', () => {
    // `generateIssueDetailsHtml` (`:2951-3053`). The order is sort-then-filter,
    // so unchecking a box must not reorder what is left.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const test2 = web.tests.find((row) => row.fullPath.endsWith('test_ext_background_early_shutdown.js'))!;

    const entries = issueEntries(file, test2, ALL_FILTERS);
    assert.ok(entries.length > 0);
    for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i - 1]!.count >= entries[i]!.count, 'count descending');
    }
    // The hand tally says 918 skips, 369 failures, 107 timeouts, 304 crashes.
    const byType = new Map<string, number>();
    for (const entry of entries) {
        byType.set(entry.type, (byType.get(entry.type) ?? 0) + entry.count);
    }
    assert.equal(byType.get('SKIP'), 918);
    assert.equal(byType.get('FAIL'), 369);
    assert.equal(byType.get('TIMEOUT'), 107);
    assert.equal(byType.get('CRASH'), 304);

    // Filtering removes a type without touching the others' order.
    const noSkips = issueEntries(file, test2, { ...ALL_FILTERS, skips: false });
    assert.ok(!noSkips.some((entry) => entry.type === 'SKIP'));
    assert.deepEqual(
        noSkips,
        entries.filter((entry) => entry.type !== 'SKIP'),
        'the surviving lines keep the order they had'
    );
});

test('the timeout line is synthetic and carries the whole timeout count', () => {
    // `:3025-3031` — the format records no per-timeout message, so there is
    // one line with the total.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const dnr = web.tests.find((row) => row.fullPath.endsWith('test_ext_dnr_dynamic_rules.js'))!;
    const timeouts = issueEntries(file, dnr, ALL_FILTERS).filter((entry) => entry.type === 'TIMEOUT');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]!.count, 445, 'the hand-tallied timeout count');
    assert.equal(timeouts[0]!.message, TIMEOUT_MESSAGE);
});

test('failures and crashes with no recorded detail get a synthetic line that balances the column', () => {
    // `:2993-2999` and `:3015-3021`. The property that matters is arithmetic:
    // the FAIL lines must sum to the test's failCount and the CRASH lines to
    // its crashCount, whether or not the file recorded messages. Without the
    // synthetic lines a reader would expand a test and find the numbers under
    // it smaller than the column above.
    const rows = buildComponentRows(file, ALL_FILTERS, '');
    for (const row of rows) {
        for (const testRow of row.tests) {
            const entries = issueEntries(file, testRow, ALL_FILTERS);
            const sum = (type: string): number =>
                entries.filter((entry) => entry.type === type).reduce((total, entry) => total + entry.count, 0);
            assert.equal(sum('FAIL'), testRow.failCount, `${testRow.fullPath} FAIL lines`);
            assert.equal(sum('CRASH'), testRow.crashCount, `${testRow.fullPath} CRASH lines`);
            assert.equal(sum('SKIP'), testRow.skipCount, `${testRow.fullPath} SKIP lines`);
            assert.equal(sum('TIMEOUT'), testRow.timeoutCount, `${testRow.fullPath} TIMEOUT lines`);
        }
    }

    // And the synthetic lines really do occur on this fixture, or the loop
    // above would be checking only the recorded-message path.
    const web = rows.find((row) => row.key === 'WebExtensions :: General')!;
    const all = web.tests.flatMap((testRow) => issueEntries(file, testRow, ALL_FILTERS));
    assert.ok(
        all.some((entry) => entry.message === CRASH_NO_SIGNATURE) ||
            all.some((entry) => entry.message === FAILURE_NO_MESSAGE),
        'the fixture must exercise at least one synthetic line'
    );
});

test('a run-if skip is not an issue', () => {
    // The rule at `:1005` and `:1519`. Asserted through the entry list, which
    // is where a reader would see it: no issue line may carry a `run-if`
    // message, and the SKIP lines must sum to the run-if-excluded count.
    for (const row of buildComponentRows(file, ALL_FILTERS, '')) {
        for (const testRow of row.tests) {
            for (const entry of issueEntries(file, testRow, ALL_FILTERS)) {
                assert.ok(
                    !entry.message.startsWith('run-if'),
                    `${testRow.fullPath}: a run-if annotation is not an issue`
                );
            }
        }
    }
});

test('the failure tooltip divides by runCount and rounds once', () => {
    // `:3063-3068`. The denominator is `runCount` — skips excluded — and not
    // the Issue% denominator, because a skipped run could not have produced
    // the message.
    assert.equal(
        failureTooltip(3, 1000),
        `3 occurrences of this message out of ${(1000).toLocaleString()} runs (0.30%)`
    );
    assert.equal(
        failureTooltip(1, 1000),
        `1 occurrence of this message out of ${(1000).toLocaleString()} runs (0.10%)`,
        'singular at one'
    );
    assert.equal(failureTooltip(5, 0), '', 'no runs, no tooltip');

    // The denominator itself, on a case where an off-by-one in it is visible.
    // A mutation using `runCount + 1` survived the assertions above, because
    // at four significant figures 1/5893 and 1/5894 both render `0.02`. Small
    // numbers separate them, and the reported run total is asserted too — the
    // tooltip states its own denominator, so a wrong one is readable.
    assert.equal(
        failureTooltip(1, 3),
        `1 occurrence of this message out of ${(3).toLocaleString()} runs (33.33%)`
    );
    assert.equal(
        failureTooltip(2, 3),
        `2 occurrences of this message out of ${(3).toLocaleString()} runs (66.67%)`,
        'rounded once from the raw ratio: 66.666… to 66.67, not 66.66'
    );
    assert.equal(
        failureTooltip(3, 3),
        `3 occurrences of this message out of ${(3).toLocaleString()} runs (100.00%)`,
        'every run of the test produced this message'
    );
    // The thousands separator comes from `toLocaleString` and is never
    // hardcoded: this machine renders 1078 with a narrow no-break space
    // (U+202F), not the ASCII space a hand-written expectation would use.
    assert.equal(
        failureTooltip(1, 1078),
        `1 occurrence of this message out of ${(1078).toLocaleString()} runs (0.09%)`
    );
});

// =========================================================================
// URL state — including the deliberate default change
// =========================================================================

test('an absent date means the 21-day aggregate', () => {
    // The migration's one deliberate behaviour change. `old/issues.html:3709-3712`
    // fell through to the date select; this treats no-date as the aggregate.
    assert.equal(isHistoricalDate(undefined), true, 'no hash at all');
    assert.equal(isHistoricalDate(''), true, 'an empty date');
    assert.equal(isHistoricalDate('21days'), true, 'the explicit value');
});

test('a named day still selects that day', () => {
    // The other half, and the one that would break a reader's bookmarks. A
    // change that made everything historical would pass the test above.
    assert.equal(isHistoricalDate('2026-08-04'), false);
    assert.equal(isHistoricalDate('2026-07-14'), false);
});

test('the hash carries date, q and view, and nothing else', () => {
    assert.deepEqual(readUrlState(new URLSearchParams('date=2026-08-04&q=socks&view=tree')), {
        date: '2026-08-04',
        q: 'socks',
        view: 'tree',
    });
    assert.deepEqual(readUrlState(new URLSearchParams('')), {});
    // An empty `q` is present-but-empty, which is how a cleared search box
    // round-trips.
    assert.deepEqual(readUrlState(new URLSearchParams('q=')), { q: '' });
    // An unknown key is not carried, which is what stops a hash from another
    // page's control silently becoming state here.
    assert.deepEqual(readUrlState(new URLSearchParams('sort=runCount')), {});
});

test('a view the page does not have is dropped rather than applied', () => {
    // The three the radios offer, each read back as itself.
    for (const view of ['components', 'tree', 'list'] as const) {
        assert.deepEqual(readUrlState(new URLSearchParams(`view=${view}`)), { view });
    }
    // And anything else. Returning `{}` is what leaves the caller on the view
    // it is already on: `site/issues.ts:loadFromUrlHash` resolves an absent
    // `view` to `DEFAULT_VIEW`, so a bogus one lands on `components` rather
    // than on a mode with no renderer.
    assert.deepEqual(readUrlState(new URLSearchParams('view=bogus')), {});
    assert.deepEqual(readUrlState(new URLSearchParams('view=')), {});
    // Case matters: the values are the ones the radios carry, not a
    // normalization of them.
    assert.deepEqual(readUrlState(new URLSearchParams('view=Tree')), {});
});
