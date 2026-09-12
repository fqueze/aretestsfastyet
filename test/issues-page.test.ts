/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/issues.ts`, the issues page controller, driven end to end in jsdom.
 *
 * ## Why this file exists
 *
 * The controller exports one thing — `start()` — and everything worth covering
 * is module-private behind it: the stat cells and their colour rules, the sort
 * header, component expansion, the per-test issue list, the four checkboxes,
 * the `?try=` short-circuit and, above all, **which file the page loads with no
 * hash**. There is no seam for those, so they are tested the way a reader
 * exercises them: by loading the page and clicking it.
 *
 * The 21-day default is the reason this file matters most. It is a change in
 * what the page *fetches*, and `test/issues-view.test.ts` can only assert the
 * predicate — `isHistoricalDate(undefined) === true`. Only a started page can
 * show that the predicate is wired to a fetch, which is why the request log is
 * asserted here.
 *
 * ## Where the expected values come from
 *
 * Not from the code under test. The component totals are tallied off the raw
 * fixture JSON by `handTally()`, which reads `tables`/`testRuns` directly and
 * imports nothing from `site/` or `lib/query/`. Class names and labels are
 * literals taken from `issues.html`'s own markup and CSS. Numbers rendered
 * into cells are compared against `toLocaleString()` of the hand-tallied
 * value, never against a hardcoded separator — this machine renders 1078 as
 * `1 078` with a narrow no-break space.
 *
 * ## The detailed file
 *
 * The page's second fetch, `xpcshell-issues-with-taskids.json`, is the one this
 * suite guards hardest, because a regression already shipped there: the
 * migration declared the file unnecessary and dropped it, which silently took
 * the run lists, the charts and the platform tooltips with it while every test
 * kept passing.
 *
 * So the assertions here are written to **fail if the fetch stops happening**,
 * not merely to describe what the page does when it does. Concretely:
 * `harness.hold()` freezes the response so the before state is observable and
 * asserted to be empty; the run rows, the message chart and the tooltip are
 * then asserted to be populated *after* release; and a dedicated test starts a
 * page with the detailed file **absent** and asserts the page still works with
 * the before state everywhere. A change that removed the fetch would fail the
 * after assertions; a change that fetched it and ignored it would fail them
 * too; a change that blocked the first render on it would fail the
 * before assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture } from './dom-harness.ts';
import type { IssuesFile, IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';

// --- ground truth, read off the raw fixtures ------------------------------

const AGGREGATE = fixture<IssuesFile>('xpcshell-issues.json');
const DETAILED = fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json');
const DAILY = fixture<{ metadata: { jobCount?: number; date?: string } }>(
    'xpcshell-2026-08-03.json'
);
const INDEX = fixture<{ dates: string[] }>('index.json');

interface Group {
    runCount: number;
    skipCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    issueCount: number;
    tests: number;
    withIssues: number;
}

/**
 * The component totals in the 21-day fixture, counted without touching
 * `site/` or `lib/query/`.
 *
 * Open-coded against `tables.statuses` and `counts` on purpose: this and the
 * page can only agree by both being right about the file.
 */
function handTally(): Map<string, Group> {
    const groups = new Map<string, Group>();
    for (let testId = 0; testId < AGGREGATE.testRuns.length; testId++) {
        const statusGroups = AGGREGATE.testRuns[testId]!;
        let pass = 0;
        let failCount = 0;
        let timeoutCount = 0;
        let crashCount = 0;
        let skipCount = 0;
        for (let statusId = 0; statusId < statusGroups.length; statusId++) {
            const group = statusGroups[statusId];
            if (!group) {
                continue;
            }
            const status = AGGREGATE.tables.statuses[statusId]!;
            const total = group.counts.reduce((sum, count) => sum + count, 0);
            if (status === 'SKIP') {
                for (let i = 0; i < group.counts.length; i++) {
                    const messageId = group.messageIds?.[i];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : AGGREGATE.tables.messages[messageId];
                    if (message === null || message === undefined || !message.startsWith('run-if')) {
                        skipCount += group.counts[i]!;
                    }
                }
            } else if (status.startsWith('TIMEOUT')) {
                timeoutCount += total;
            } else if (status === 'CRASH') {
                crashCount += total;
            } else if (status.startsWith('PASS') || status === 'EXPECTED-FAIL') {
                // Both land in runCount; the page folds EXPECTED-FAIL into
                // passes and the library names it, and neither is displayed.
                pass += total;
            } else {
                failCount += total;
            }
        }
        const componentId = AGGREGATE.testInfo.componentIds?.[testId];
        const key =
            componentId === null || componentId === undefined
                ? '(no component)'
                : AGGREGATE.tables.components[componentId]!;
        let group = groups.get(key);
        if (group === undefined) {
            group = { runCount: 0, skipCount: 0, failCount: 0, timeoutCount: 0, crashCount: 0, issueCount: 0, tests: 0, withIssues: 0 };
            groups.set(key, group);
        }
        group.runCount += pass + failCount + timeoutCount + crashCount;
        group.skipCount += skipCount;
        group.failCount += failCount;
        group.timeoutCount += timeoutCount;
        group.crashCount += crashCount;
        group.tests += 1;
        if (skipCount + failCount + timeoutCount + crashCount > 0) {
            group.withIssues += 1;
        }
    }
    for (const group of groups.values()) {
        group.issueCount = group.skipCount + group.failCount + group.timeoutCount + group.crashCount;
    }
    return groups;
}

const TALLY = handTally();
/** The rows the default view must show: most issues first. */
const EXPECTED_ROWS = [...TALLY]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => b.issueCount - a.issueCount);

test('the fixture exercises what this suite claims to cover', () => {
    // Vacuity guard: every assertion below is conditional on the fixture
    // containing the case, so a future fixture that lost one would leave the
    // test passing with nothing to check.
    assert.ok(EXPECTED_ROWS.length > 1, 'several components, so order means something');
    assert.ok(
        EXPECTED_ROWS.some((row) => row.withIssues < row.tests),
        'a component with a clean test, so "out of M" is reachable'
    );
    assert.ok(
        EXPECTED_ROWS.some((row) => row.withIssues === row.tests),
        'a component where every test has an issue, so the no-"out of" branch is reachable'
    );
    assert.ok(
        EXPECTED_ROWS.some((row) => row.skipCount > 0) &&
            EXPECTED_ROWS.some((row) => row.skipCount === 0),
        'both skipped and unskipped components, so the denominator change is observable'
    );
});

// --- the harness ----------------------------------------------------------

const FILES = {
    'index.json': INDEX,
    'xpcshell-issues.json': AGGREGATE,
    'xpcshell-issues-with-taskids.json': DETAILED,
    'xpcshell-2026-08-03.json': DAILY,
};

// --- ground truth for the detailed file -----------------------------------

/**
 * The two fixtures must describe the same 21 days, or every "the merge changes
 * no number" assertion below is vacuous.
 *
 * Checked here rather than trusted, because the merge replaces `testRuns`
 * wholesale: a detailed fixture regenerated from a different day would make the
 * page show one set of numbers before the merge and another after, and the only
 * thing standing between that and a green suite is this comparison.
 */
test('the two 21-day fixtures are the same window, group for group', () => {
    assert.deepEqual(AGGREGATE.tables.statuses, DETAILED.tables.statuses);
    assert.deepEqual(AGGREGATE.tables.messages, DETAILED.tables.messages);
    assert.deepEqual(AGGREGATE.testInfo, DETAILED.testInfo);
    assert.equal(AGGREGATE.metadata.startTime, DETAILED.metadata.startTime);
    assert.equal(AGGREGATE.metadata.days, DETAILED.metadata.days);
    assert.equal(AGGREGATE.testRuns.length, DETAILED.testRuns.length);

    /** A group's run total, whichever of the two shapes it is in. */
    const total = (group: unknown): number | null => {
        if (group === null || group === undefined) {
            return null;
        }
        const g = group as { counts?: number[]; taskIdIds?: number[][] };
        if (g.counts !== undefined) {
            return g.counts.reduce((sum, n) => sum + n, 0);
        }
        return (g.taskIdIds ?? []).reduce((sum, bucket) => sum + bucket.length, 0);
    };

    let compared = 0;
    let attributed = 0;
    for (let testId = 0; testId < AGGREGATE.testRuns.length; testId++) {
        for (let statusId = 0; statusId < AGGREGATE.tables.statuses.length; statusId++) {
            const plain = AGGREGATE.testRuns[testId]?.[statusId];
            const detailed = DETAILED.testRuns[testId]?.[statusId];
            assert.equal(
                total(plain),
                total(detailed),
                `test ${testId} status ${AGGREGATE.tables.statuses[statusId]} differs`
            );
            compared += 1;
            if ((detailed as { taskIdIds?: unknown })?.taskIdIds !== undefined) {
                attributed += 1;
            }
        }
    }
    assert.ok(compared > 100, `only ${compared} groups compared`);
    assert.ok(attributed > 10, `the detailed fixture attributes only ${attributed} groups`);
});

/**
 * A test's FAIL messages in the detailed fixture, with the day each occurred
 * on and the statuses it was recorded under.
 *
 * Open-coded against `testRuns`/`tables`, importing nothing from `site/` — this
 * and the page can only agree by both being right about the file. The
 * `days` array is delta-encoded, so the day index is a running sum.
 */
function handFailures(testId: number): Map<
    string,
    { total: number; byDay: Map<number, number>; statuses: Set<string> }
> {
    const out = new Map<
        string,
        { total: number; byDay: Map<number, number>; statuses: Set<string> }
    >();
    const statuses = DETAILED.tables.statuses;
    for (let statusId = 0; statusId < statuses.length; statusId++) {
        const status = statuses[statusId]!;
        if (!status.startsWith('FAIL')) {
            continue;
        }
        const group = DETAILED.testRuns[testId]?.[statusId] as
            | { days: number[]; messageIds?: (number | null)[]; taskIdIds: number[][] }
            | null
            | undefined;
        if (!group) {
            continue;
        }
        let day = 0;
        for (let i = 0; i < group.days.length; i++) {
            day += group.days[i]!;
            const messageId = group.messageIds?.[i];
            const message =
                messageId === null || messageId === undefined
                    ? ''
                    : DETAILED.tables.messages[messageId]!;
            let entry = out.get(message);
            if (entry === undefined) {
                entry = { total: 0, byDay: new Map(), statuses: new Set() };
                out.set(message, entry);
            }
            const count = group.taskIdIds[i]!.length;
            entry.total += count;
            entry.byDay.set(day, (entry.byDay.get(day) ?? 0) + count);
            entry.statuses.add(status);
        }
    }
    return out;
}

/** Every job name the detailed fixture attributes to a test's runs of a status. */
function handJobNames(testId: number, statusPrefix: string): string[] {
    const names: string[] = [];
    const statuses = DETAILED.tables.statuses;
    for (let statusId = 0; statusId < statuses.length; statusId++) {
        if (!statuses[statusId]!.startsWith(statusPrefix)) {
            continue;
        }
        const group = DETAILED.testRuns[testId]?.[statusId] as
            | { taskIdIds: number[][] }
            | null
            | undefined;
        if (!group) {
            continue;
        }
        for (const bucket of group.taskIdIds) {
            for (const index of bucket) {
                names.push(DETAILED.tables.jobNames[DETAILED.taskInfo.jobNameIds[index]!]!);
            }
        }
    }
    return names;
}

/** A test's full path in the detailed fixture, by test id. */
function testPathOf(testId: number): string {
    return (
        `${DETAILED.tables.testPaths[DETAILED.testInfo.testPathIds[testId]!]!}/` +
        `${DETAILED.tables.testNames[DETAILED.testInfo.testNameIds[testId]!]!}`
    );
}

/** The inverse, for turning a rendered row's `data-path` back into an id. */
function pathToTestId(fullPath: string): number {
    for (let testId = 0; testId < DETAILED.testRuns.length; testId++) {
        if (testPathOf(testId) === fullPath) {
            return testId;
        }
    }
    throw new Error(`no test in the fixture at ${fullPath}`);
}

/** The `YYYY-MM-DD` label of a day index, from the fixture's own `startTime`. */
function handDate(day: number): string {
    return new Date((DETAILED.metadata.startTime + day * 86400) * 1000)
        .toISOString()
        .split('T')[0]!;
}

/**
 * The test this suite drives the run list and the message chart through.
 *
 * `netwerk/test/unit/test_trr_https_fallback.js`, chosen because it is the
 * fixture's example of the case divergence 6 is about: the message
 * `Could not get contentLength` was recorded under **two** FAIL statuses, so a
 * chart that stopped at the first would undercount it.
 */
const FAIL_TEST = 'netwerk/test/unit/test_trr_https_fallback.js';
const FAIL_TEST_ID = 1;
const SPLIT_MESSAGE = 'Could not get contentLength';

test('the detailed fixture exercises the multi-status case divergence 6 is about', () => {
    // Vacuity guard. Every assertion about the split message is worthless if
    // the fixture stopped containing one.
    const path =
        `${DETAILED.tables.testPaths[DETAILED.testInfo.testPathIds[FAIL_TEST_ID]!]!}/` +
        `${DETAILED.tables.testNames[DETAILED.testInfo.testNameIds[FAIL_TEST_ID]!]!}`;
    assert.equal(path, FAIL_TEST, 'the test id and the path still agree');

    const failures = handFailures(FAIL_TEST_ID);
    const split = failures.get(SPLIT_MESSAGE);
    assert.ok(split !== undefined, `the fixture no longer has "${SPLIT_MESSAGE}"`);
    assert.ok(
        split.statuses.size > 1,
        `"${SPLIT_MESSAGE}" is under one status only (${[...split.statuses]}), ` +
            'so the divergence-6 assertion below proves nothing'
    );
    assert.ok(split.byDay.size > 1, 'and it spans more than one day, so the chart has shape');
});

/**
 * A page, started, with no hash — which is the case under test.
 *
 * The controller holds module-level state (the sort, the filters, the expanded
 * set), so it is imported **once** and every test shares it; tests leave the
 * page as they found it.
 */
const harness = setupPage({
    page: 'issues',
    url: 'https://tests.firefox.dev/issues.html',
    files: FILES,
});
const { start } = await import('../site/issues.ts');
await start();

const table = (): HTMLElement => harness.content.querySelector('.tree-table')!;
const componentRows = (): HTMLElement[] => [
    ...table().querySelectorAll<HTMLElement>('.folder-row'),
];
const testRows = (): HTMLElement[] => [...table().querySelectorAll<HTMLElement>('.test-row')];
const searchBox = (): HTMLInputElement =>
    harness.document.getElementById('search-box') as HTMLInputElement;
const checkbox = (id: string): HTMLInputElement =>
    harness.document.getElementById(id) as HTMLInputElement;

/** A row's stat cells as `label -> value`, read out of the rendered DOM. */
function statsOf(row: Element): Map<string, string> {
    const out = new Map<string, string>();
    for (const item of row.querySelectorAll('.stat-item')) {
        const label = item.querySelector('.stat-label')?.textContent ?? '';
        const value = item.querySelector('.stat-value')?.textContent ?? '';
        out.set(label, value);
    }
    return out;
}

/** The class on a row's stat value, for the colour assertions. */
function valueClassOf(row: Element, label: string): string {
    for (const item of row.querySelectorAll('.stat-item')) {
        if ((item.querySelector('.stat-label')?.textContent ?? '') === label) {
            return item.querySelector('.stat-value')?.className ?? '';
        }
    }
    return '';
}

/** Collapses every open component, so the next test starts from a known page. */
function collapseAll(): void {
    for (const row of componentRows()) {
        if (row.classList.contains('expanded')) {
            row.click();
        }
    }
}

/** Restores the four checkboxes to all-on and re-renders. */
function resetFilters(): void {
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        if (!box.checked) {
            box.checked = true;
            box.dispatchEvent(new harness.window.Event('change'));
        }
    }
}

/**
 * Clicks one of the three "Show as" radios, as a reader would.
 *
 * `checked = true` then `change`, which is what a click on a radio produces —
 * and *not* `click()`, because jsdom's radio-group behaviour on a synthetic
 * click is the thing under test's input rather than something to rely on.
 * Setting `checked` unchecks the group's other members, so the page's
 * `selectedView()` sees exactly one.
 */
function switchView(id: 'view-components' | 'view-tree' | 'view-list'): void {
    const radio = checkbox(id);
    radio.checked = true;
    radio.dispatchEvent(new harness.window.Event('change'));
}

/** Back to the default mode, so the next test starts where the page loaded. */
function resetView(): void {
    switchView('view-components');
}

// =========================================================================
// The 21-day default — the migration's deliberate change
// =========================================================================

test('with no hash the page loads the 21-day aggregate, not a single day', () => {
    // The whole point of sequencing this page last. `old/issues.html:3709-3712`
    // called `loadData()`, which fetches `{harness}-<date>.json`; this must
    // fetch `{harness}-issues.json` instead.
    //
    // Asserted on the **request log**, which is the only place the difference
    // is visible: both files decode into the same interface, so a page that
    // loaded the wrong one would still render a plausible table.
    assert.ok(
        harness.requested.includes('xpcshell-issues.json'),
        `the 21-day aggregate must be fetched; asked for ${harness.requested.join(', ')}`
    );
    assert.ok(
        !harness.requested.includes('xpcshell-2026-08-03.json'),
        'and the daily file must not be, or the page did the old thing as well'
    );
});

test('the status text names the 21-day window', () => {
    // What a reader sees, rather than what was fetched. `old/issues.html:3584`
    // formats it as `N days (start to end)`.
    const status = harness.document.getElementById('status-text')!.textContent ?? '';
    assert.match(status, /^21 days \(2026-07-14 to 2026-08-03\)$/, `status text was "${status}"`);
});

test('the hash records the 21-day window, so the URL is shareable', () => {
    assert.match(harness.window.location.hash, /date=21days/);
});

// =========================================================================
// The default render
// =========================================================================

test('rows are components, ranked by issue count descending', () => {
    // The framing assertion: the row unit and the ranking, against the hand
    // tally rather than against the page's own ordering.
    const names = componentRows().map(
        (row) => row.querySelector('strong')?.textContent ?? ''
    );
    assert.deepEqual(names, EXPECTED_ROWS.map((row) => row.key));
    assert.equal(names[0], 'WebExtensions :: General');
});

test('a component row shows the seven stat columns with the tallied numbers', () => {
    const row = componentRows()[0]!;
    const stats = statsOf(row);
    const expected = TALLY.get('WebExtensions :: General')!;

    assert.deepEqual(
        [...stats.keys()],
        ['Runs', 'Issue %', 'Issues', 'Skips', 'Failures', 'Timeouts', 'Crashes'],
        'the seven columns, in the order old/issues.html:2121-2127 emits them'
    );
    // Built with `toLocaleString()`, never a hardcoded separator.
    assert.equal(stats.get('Runs'), expected.runCount.toLocaleString());
    assert.equal(stats.get('Issues'), expected.issueCount.toLocaleString());
    assert.equal(stats.get('Skips'), expected.skipCount.toLocaleString());
    assert.equal(stats.get('Failures'), expected.failCount.toLocaleString());
    assert.equal(stats.get('Timeouts'), expected.timeoutCount.toLocaleString());
    assert.equal(stats.get('Crashes'), expected.crashCount.toLocaleString());
    // 14,222 / (97,473 + 10,713) = 13.145…%, which rounds to 13.
    assert.equal(stats.get('Issue %'), '13%');
});

test('the header says how many tests have issues, out of how many', () => {
    // `old/issues.html:2106`. WebExtensions has 7 tests, 6 with an issue.
    const row = componentRows()[0]!;
    const expected = TALLY.get('WebExtensions :: General')!;
    const text = row.querySelector('.tree-name')?.textContent ?? '';
    assert.ok(
        text.includes(`(${expected.withIssues} tests with issues, out of ${expected.tests})`),
        `header read "${text}"`
    );
    assert.equal(expected.withIssues, 6);
    assert.equal(expected.tests, 7);

    // And the other branch: a component where every test has an issue omits
    // the "out of", because `1 of 1` tells a reader nothing.
    const xpconnect = componentRows().find(
        (candidate) => candidate.querySelector('strong')?.textContent === 'Core :: XPConnect'
    )!;
    const xpText = xpconnect.querySelector('.tree-name')?.textContent ?? '';
    assert.ok(xpText.includes('(1 test with issues)'), `header read "${xpText}"`);
    assert.ok(!xpText.includes('out of'), 'no "out of" when every test has an issue');
});

test('a zero stat is faded and a populated one is not', () => {
    // The `hideable-zero` rule (`old/issues.html:62-70`), which is what keeps a
    // seven-column row readable. Core :: Networking has 0 crashes.
    const networking = componentRows().find(
        (row) => row.querySelector('strong')?.textContent === 'Core :: Networking'
    )!;
    const crashItem = [...networking.querySelectorAll('.stat-item')].find(
        (item) => item.querySelector('.stat-label')?.textContent === 'Crashes'
    )!;
    assert.ok(crashItem.classList.contains('hideable-zero'), 'a zero crash count is faded');
    assert.equal(valueClassOf(networking, 'Crashes'), 'stat-value zero');

    const failItem = [...networking.querySelectorAll('.stat-item')].find(
        (item) => item.querySelector('.stat-label')?.textContent === 'Failures'
    )!;
    assert.ok(!failItem.classList.contains('hideable-zero'), '8 failures is not faded');
    assert.equal(valueClassOf(networking, 'Failures'), 'stat-value fail');

    // Driven over every column of every row rather than one cell, because a
    // mutation that dropped the class from the *Issues* column alone survived
    // the two assertions above: no component on this fixture has a zero issue
    // count in the default view, so that branch is only reachable through the
    // other columns and through the filters-off state exercised below.
    const faded = (row: Element, label: string): boolean =>
        [...row.querySelectorAll('.stat-item')].some(
            (item) =>
                item.querySelector('.stat-label')?.textContent === label &&
                item.classList.contains('hideable-zero')
        );
    for (const row of componentRows()) {
        const stats = statsOf(row);
        for (const label of ['Issues', 'Skips', 'Failures', 'Timeouts', 'Crashes']) {
            const isZero = stats.get(label) === '0';
            assert.equal(
                faded(row, label),
                isZero,
                `${row.querySelector('strong')?.textContent} ${label}=${stats.get(label)}: a ` +
                    'zero must be faded and a non-zero must not be'
            );
        }
    }
    // The Issues column really does reach zero once nothing is counted, which
    // is the state that makes the loop above cover it.
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    for (const row of componentRows()) {
        assert.equal(statsOf(row).get('Issues'), '0');
        assert.ok(faded(row, 'Issues'), 'a zero Issues cell is faded too');
    }
    resetFilters();
});

test('there is no total row, because the old page never rendered one', () => {
    // `buildTotalSummaryRow` (`old/issues.html:1833`) is defined and never called
    // — divergence 4. Asserted so that "we did not port it" cannot quietly
    // become "we forgot it and nobody noticed".
    assert.equal(table().querySelectorAll('.total-row').length, 0);
});

// =========================================================================
// Sorting
// =========================================================================

test('clicking a column header re-ranks the rows by that column', () => {
    // Crashes is the discriminating column on this fixture: its order differs
    // from the default issueCount order, so a header that did nothing — or
    // that always sorted by the default — fails here.
    const byCrashes = [...TALLY]
        .map(([key, group]) => ({ key, crashCount: group.crashCount }))
        .sort((a, b) => b.crashCount - a.crashCount)
        .map((row) => row.key);
    assert.notDeepEqual(
        byCrashes,
        EXPECTED_ROWS.map((row) => row.key),
        'the two orders must differ, or this test cannot tell them apart'
    );

    // Re-queried after every click rather than held: a render rebuilds the
    // header, so the element that was clicked is detached by the time the
    // assertion runs. Holding the reference reported `active: false` on a page
    // that was behaving correctly.
    const header = (): HTMLElement =>
        table().querySelector<HTMLElement>('.sort-button[data-field="crashCount"]')!;

    header().click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        byCrashes
    );
    assert.ok(header().classList.contains('active'), 'the clicked column is marked active');
    assert.equal(header().querySelector('.sort-arrow')?.textContent, '↓', 'descending first');
    assert.ok(
        !table()
            .querySelector('.sort-button[data-field="issueCount"]')!
            .classList.contains('active'),
        'and the previous column is no longer active'
    );

    // Clicking again flips it.
    header().click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        [...byCrashes].reverse()
    );
    assert.equal(harness.document.querySelector('.sort-button[data-field="crashCount"] .sort-arrow')?.textContent, '↑');

    // Back to the default for the tests that follow.
    table().querySelector<HTMLElement>('.sort-button[data-field="issueCount"]')!.click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        EXPECTED_ROWS.map((row) => row.key)
    );
});

test('the rate column sorts ascending first, unlike the counts', () => {
    // `changeSortOrder` (`:1193-1197`) — the one exception, and exactly the
    // kind of detail a rewrite drops.
    const button = table().querySelector<HTMLElement>('.sort-button[data-field="issuePercentage"]')!;
    button.click();
    assert.equal(
        harness.document.querySelector('.sort-button[data-field="issuePercentage"] .sort-arrow')
            ?.textContent,
        '↑',
        'a rate column opens ascending'
    );
    // XPConnect's 0.068% is the smallest, so it comes first.
    assert.equal(componentRows()[0]!.querySelector('strong')?.textContent, 'Core :: XPConnect');

    table().querySelector<HTMLElement>('.sort-button[data-field="issueCount"]')!.click();
    assert.equal(
        harness.document.querySelector('.sort-button[data-field="issueCount"] .sort-arrow')
            ?.textContent,
        '↓',
        'a count column opens descending'
    );
});

// =========================================================================
// The "Show as" radios
// =========================================================================

test('the page opens on bugzilla components, with that radio checked', () => {
    // The default the owner confirmed stays. Asserted on the DOM rather than
    // on the module's state, because a page whose markup said `components` and
    // whose renderer grouped by directory would pass any state-only check.
    assert.equal(checkbox('view-components').checked, true);
    assert.equal(checkbox('view-tree').checked, false);
    assert.equal(checkbox('view-list').checked, false);
    assert.deepEqual(
        componentRows().map((row) => row.dataset['path']),
        EXPECTED_ROWS.map((row) => row.key),
        'and the rows really are the components'
    );
});

test('the source tree radio re-renders one row per directory', () => {
    collapseAll();
    switchView('view-tree');

    const keys = componentRows().map((row) => row.dataset['path']);
    assert.deepEqual(
        [...keys].sort(),
        ['ipc/testshell/tests', 'netwerk/test/unit', 'toolkit/components/extensions/test/xpcshell'],
        'the keys are directories, which no component name in this fixture is'
    );
    // The rows are still expandable group rows with the seven stat columns —
    // the same renderer, so a directory row is not a degraded one.
    const biggest = componentRows()[0]!;
    assert.equal(biggest.dataset['path'], 'toolkit/components/extensions/test/xpcshell');
    assert.equal(statsOf(biggest).size, 7);
    biggest.click();
    assert.ok(testRows().length > 0, 'a directory row expands to its tests');
    assert.ok(
        testRows().every((row) => row.dataset['path']?.startsWith('toolkit/components/')),
        'and only to the tests in that directory'
    );
    collapseAll();
    resetView();
});

test('the list radio renders every test with an issue, with no group row', () => {
    collapseAll();
    switchView('view-list');

    assert.equal(componentRows().length, 0, 'no folder rows at all in this mode');
    const paths = testRows().map((row) => row.dataset['path']);
    // 8 of the fixture's 10 tests have an issue with all four types on; the
    // clean test and no other is missing. Counted off `TALLY`, which is
    // hand-tallied from the raw file.
    const expected = EXPECTED_ROWS.reduce((sum, group) => sum + group.withIssues, 0);
    assert.equal(paths.length, expected);
    assert.ok(
        !paths.some((path) => path?.endsWith('test_ext_always_green.js')),
        'the clean test is not a row'
    );
    // A list row is top-level, unlike the same test under a group row.
    for (const row of testRows()) {
        assert.equal(row.dataset['level'], '0');
        assert.equal(row.querySelector('.tree-indent'), null, 'and carries no indent');
    }
    resetView();
});

test('a list row still expands to its issues', () => {
    // The per-test drill-down is the same one the grouped modes have; the only
    // difference is what the row hangs off. A mode that rendered rows without
    // their click handler would pass every assertion above.
    switchView('view-list');
    const row = testRows().find((test) =>
        test.dataset['path']?.endsWith('test_ext_dnr_dynamic_rules.js')
    )!;
    row.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 1);
    assert.ok(harness.document.querySelectorAll('.issue-item').length > 0);
    row.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 0);
    resetView();
});

test('the sort survives a view change, and applies to the new rows', () => {
    // Unlike `site/errors.ts:onViewChange`, which resets it: the eight columns
    // are the same eight in all three modes here. Ranked ascending by Runs so
    // the expectation is not the default order.
    resetView();
    collapseAll();
    const sortArrow = (field: string): string =>
        harness.document.querySelector(`.sort-button[data-field="${field}"] .sort-arrow`)
            ?.textContent ?? '';
    const clickSort = (field: string): void => {
        harness.document.querySelector<HTMLElement>(`.sort-button[data-field="${field}"]`)!.click();
    };

    // First click on a count column opens descending, second flips it.
    clickSort('runCount');
    clickSort('runCount');
    assert.equal(sortArrow('runCount'), '↑');

    switchView('view-list');
    assert.equal(
        sortArrow('runCount'),
        '↑',
        'the header still shows the sort the reader chose'
    );
    const runs = testRows().map((row) => Number(statsOf(row).get('Runs')!.replace(/\D/g, '')));
    assert.ok(runs.length > 1, 'several rows, so an order means something');
    assert.deepEqual(runs, [...runs].sort((a, b) => a - b), 'and the rows obey it');

    // Back to the page's initial sort and mode for the tests below: one more
    // click on `runCount` would only flip it, so the default column is
    // selected and then flipped back to descending.
    resetView();
    clickSort('issueCount');
    if (sortArrow('issueCount') !== '↓') {
        clickSort('issueCount');
    }
    assert.equal(sortArrow('issueCount'), '↓', 'restored to INITIAL_SORT');
});

test('switching views closes whatever was open', () => {
    // A component key and a directory key name different rows, so carrying the
    // expansion across would leave keys matching nothing — and on a switch
    // back would re-open a row the reader had closed.
    resetView();
    collapseAll();
    componentRows()[0]!.click();
    assert.ok(testRows().length > 0);

    switchView('view-tree');
    assert.equal(testRows().length, 0, 'nothing is expanded in the new mode');
    assert.equal(
        componentRows().filter((row) => row.classList.contains('expanded')).length,
        0
    );

    switchView('view-components');
    assert.equal(testRows().length, 0, 'and nothing re-opens on the way back');
});

test('the hash carries a non-default view and drops the default one', () => {
    // `xpcshell-timings.html:572` — `if (view !== 'components')`. The owner's
    // usual URL is `#date=21days`, so a `view=components` written on every
    // render would be noise in every link they share.
    resetView();
    assert.ok(
        !harness.window.location.hash.includes('view='),
        `the default must not be written; hash was ${harness.window.location.hash}`
    );

    switchView('view-tree');
    assert.match(harness.window.location.hash, /view=tree/);
    assert.match(harness.window.location.hash, /date=21days/, 'and the date is still there');

    switchView('view-list');
    assert.match(harness.window.location.hash, /view=list/);

    resetView();
    assert.ok(!harness.window.location.hash.includes('view='), 'and it goes away again');
});

test('#view= in the URL selects the mode on load', async () => {
    // The read-back half, which `test/issues-view.test.ts` can only assert as
    // a predicate: only a started page shows the parameter reaching a radio
    // and the radio reaching the renderer. A fresh module instance each time,
    // because the shared harness has already been switched around above.
    const listPage = await freshPage(
        'viewlist',
        FILES,
        'https://tests.firefox.dev/issues.html#date=21days&view=list'
    );
    try {
        assert.equal(
            (listPage.document.getElementById('view-list') as HTMLInputElement).checked,
            true
        );
        assert.equal(
            listPage.document.querySelectorAll('.tree-table .folder-row').length,
            0,
            'it opened on the flat list, not on components'
        );
        assert.ok(listPage.document.querySelectorAll('.tree-table .test-row').length > 0);
    } finally {
        listPage.restore();
    }

    // And a value the page does not have leaves it on the default rather than
    // on a mode with no renderer.
    const bogus = await freshPage(
        'viewbogus',
        FILES,
        'https://tests.firefox.dev/issues.html#date=21days&view=bogus'
    );
    try {
        assert.equal(
            (bogus.document.getElementById('view-components') as HTMLInputElement).checked,
            true
        );
        assert.ok(bogus.document.querySelectorAll('.tree-table .folder-row').length > 0);
    } finally {
        bogus.restore();
    }
});

// =========================================================================
// Expansion
// =========================================================================

test('clicking a component lists its tests with issues, and only those', () => {
    collapseAll();
    assert.equal(testRows().length, 0, 'nothing is expanded to begin with');

    const row = componentRows()[0]!;
    row.click();

    const expected = TALLY.get('WebExtensions :: General')!;
    assert.equal(testRows().length, expected.withIssues, 'one row per test with an issue');
    const paths = testRows().map((test) => test.dataset['path']);
    assert.ok(
        !paths.some((path) => path?.endsWith('test_ext_always_green.js')),
        'the clean test is not listed'
    );
    assert.ok(paths.some((path) => path?.endsWith('test_ext_dnr_dynamic_rules.js')));
    assert.ok(row.classList.contains('expanded'));

    // Clicking again closes it.
    row.click();
    assert.equal(testRows().length, 0);
    assert.ok(!row.classList.contains('expanded'));
});

test('two components can be open at once', () => {
    // Unlike the per-test details, which close each other. The distinction is
    // upstream's (`expandedRows` is a Set at `:662`) and a reader relies on it
    // to compare two components side by side.
    collapseAll();
    componentRows()[0]!.click();
    const afterFirst = testRows().length;
    componentRows()[1]!.click();
    assert.ok(testRows().length > afterFirst, 'the second expansion adds rows rather than replacing');
    assert.equal(
        componentRows().filter((row) => row.classList.contains('expanded')).length,
        2
    );
    collapseAll();
});

test('a component with no tests to show is not clickable', () => {
    // `old/issues.html:2094` marks it `non-clickable`, and `:2200` attaches the
    // listener only to rows without that class. Reached by turning every
    // filter off.
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    const rows = componentRows();
    assert.ok(rows.length > 0, 'the components are still listed');
    for (const row of rows) {
        assert.ok(row.classList.contains('non-clickable'), 'no issues, so nothing to expand');
    }
    rows[0]!.click();
    assert.equal(testRows().length, 0, 'clicking does nothing');

    resetFilters();
    assert.ok(!componentRows()[0]!.classList.contains('non-clickable'));
});

test('expanding a test lists its issues, badged and count-ordered', () => {
    collapseAll();
    componentRows()[0]!.click();
    const testRow = testRows().find((row) =>
        row.dataset['path']?.endsWith('test_ext_background_early_shutdown.js')
    )!;
    testRow.click();

    const details = testRow.nextElementSibling!;
    assert.ok(details.classList.contains('issue-details-row'));
    const items = [...details.querySelectorAll('.issue-item')];
    assert.ok(items.length > 0);

    const counts = items.map((item) => Number(item.querySelector('.issue-count')?.textContent));
    for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i - 1]! >= counts[i]!, 'count descending');
    }
    // The badges are the four types, with the classes the stylesheet styles.
    for (const item of items) {
        const badge = item.querySelector('.issue-badge')!;
        const type = badge.textContent ?? '';
        assert.ok(['SKIP', 'FAIL', 'CRASH', 'TIMEOUT'].includes(type));
        assert.ok(
            badge.classList.contains(
                type === 'SKIP' ? 'badge-skip'
                    : type === 'FAIL' ? 'badge-fail'
                    : type === 'CRASH' ? 'badge-crash'
                    : 'badge-timeout'
            ),
            `${type} carries its own badge class`
        );
    }

    // The lines sum to the columns above them — the property the two synthetic
    // "not recorded" lines exist to preserve.
    const sum = (type: string): number =>
        items
            .filter((item) => item.querySelector('.issue-badge')?.textContent === type)
            .reduce((total, item) => total + Number(item.querySelector('.issue-count')?.textContent), 0);
    const stats = statsOf(testRow);
    assert.equal(sum('FAIL').toLocaleString(), stats.get('Failures'));
    assert.equal(sum('SKIP').toLocaleString(), stats.get('Skips'));
    assert.equal(sum('CRASH').toLocaleString(), stats.get('Crashes'));
    assert.equal(sum('TIMEOUT').toLocaleString(), stats.get('Timeouts'));

    testRow.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 0);
    collapseAll();
});

test('opening one test closes any other', () => {
    // `old/issues.html:2349-2351`, and the opposite of the component behaviour.
    collapseAll();
    componentRows()[0]!.click();
    const rows = testRows();
    rows[0]!.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 1);
    rows[1]!.click();
    assert.equal(
        harness.document.querySelectorAll('.issue-details-row').length,
        1,
        'the first one closed'
    );
    assert.ok(rows[1]!.nextElementSibling?.classList.contains('issue-details-row'));
    rows[1]!.click();
    collapseAll();
});

// =========================================================================
// The four checkboxes
// =========================================================================

test('unchecking skips changes the numbers without hiding the component', () => {
    // The property the page turns on: the boxes are not row filters. Both the
    // count and the *rate* are checked, because a denominator that kept the
    // skips would still produce a smaller-looking number.
    const before = statsOf(componentRows()[0]!);
    const expected = TALLY.get('WebExtensions :: General')!;
    assert.equal(before.get('Issues'), expected.issueCount.toLocaleString());

    const box = checkbox('filter-skips');
    box.checked = false;
    box.dispatchEvent(new harness.window.Event('change'));

    const web = componentRows().find(
        (row) => row.querySelector('strong')?.textContent === 'WebExtensions :: General'
    )!;
    const after = statsOf(web);
    const withoutSkips =
        expected.failCount + expected.timeoutCount + expected.crashCount;
    assert.equal(after.get('Issues'), withoutSkips.toLocaleString(), 'skips leave the numerator');
    assert.equal(
        after.get('Skips'),
        expected.skipCount.toLocaleString(),
        'but the Skips column still reports them'
    );
    // 3,509 / 97,473 = 3.60% → 4%. With the skips left in the denominator it
    // would be 3,509 / 108,186 = 3.24% → 3%, so the band distinguishes them.
    assert.equal(after.get('Issue %'), '4%', 'the skipped runs leave the denominator too');

    resetFilters();
    assert.equal(statsOf(componentRows()[0]!).get('Issue %'), '13%');
});

test('unchecking a type drops the tests whose only issues were of that type', () => {
    // A test needs an issue of an *enabled* type to be listed (`:2016`).
    collapseAll();
    const box = checkbox('filter-failures');

    // With everything on, geckoProfiler_control (skips + crashes, no failures)
    // is listed.
    componentRows()[0]!.click();
    assert.ok(
        testRows().some((row) => row.dataset['path']?.endsWith('test_ext_geckoProfiler_control.js'))
    );
    collapseAll();

    // With only failures counted, it is not.
    for (const id of ['filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const other = checkbox(id);
        other.checked = false;
        other.dispatchEvent(new harness.window.Event('change'));
    }
    assert.ok(box.checked, 'failures stay on');
    componentRows()[0]!.click();
    const paths = testRows().map((row) => row.dataset['path']);
    assert.ok(
        !paths.some((path) => path?.endsWith('test_ext_geckoProfiler_control.js')),
        'a skip-and-crash-only test is not an issue when only failures count'
    );
    assert.ok(paths.some((path) => path?.endsWith('test_ext_dnr_dynamic_rules.js')));

    collapseAll();
    resetFilters();
});

test('all four boxes off leaves every component at zero issues', () => {
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    for (const row of componentRows()) {
        assert.equal(statsOf(row).get('Issues'), '0');
        assert.equal(statsOf(row).get('Issue %'), '0%');
        // But the run totals survive, because they do not depend on the types.
        assert.notEqual(statsOf(row).get('Runs'), '0');
    }
    resetFilters();
});

// =========================================================================
// The search
// =========================================================================

test('a search on a component name keeps it and drops the others', async () => {
    // Both directions in one test: what survives *and* what disappears. An
    // earlier test in this repo asserted only that a search "keeps rows whole"
    // and never that non-matching rows go away, so the filter could have been
    // deleted with the suite still green.
    assert.ok(componentRows().length > 1, 'more than one row to narrow from');

    searchBox().value = 'networking';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const names = componentRows().map((row) => row.querySelector('strong')?.textContent);
    assert.deepEqual(names, ['Core :: Networking'], 'only the matching component survives');

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, EXPECTED_ROWS.length, 'clearing restores every row');
});

test('a search on a test path narrows the component to that test', async () => {
    searchBox().value = 'test_socks';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const rows = componentRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.querySelector('strong')?.textContent, 'Core :: Networking');
    // The row's numbers are recomputed over the kept test: 12,840 runs, not
    // the component's whole 18,612.
    assert.equal(statsOf(rows[0]!).get('Runs'), (12840).toLocaleString());

    rows[0]!.click();
    assert.deepEqual(
        testRows().map((row) => row.dataset['path']),
        ['netwerk/test/unit/test_socks.js']
    );
    collapseAll();

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
});

test('a search matching nothing empties the list', async () => {
    searchBox().value = 'zzz-no-such-thing';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, 0);

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, EXPECTED_ROWS.length);
});

// =========================================================================
// A named day still works
// =========================================================================

test('#date=<a day> loads that day, not the aggregate', async () => {
    // The other half of the default change: a bookmarked day has to keep
    // working, and it reads a **different file with a different shape**.
    const day = setupPage({
        page: 'issues',
        url: 'https://tests.firefox.dev/issues.html#date=2026-08-03',
        files: FILES,
    });
    try {
        const module = await import(`../site/issues.ts?day=${Date.now()}`);
        await (module as { start: () => Promise<void> }).start();

        assert.ok(
            day.requested.includes('xpcshell-2026-08-03.json'),
            `the daily file must be fetched; asked for ${day.requested.join(', ')}`
        );
        const status = day.document.getElementById('status-text')?.textContent ?? '';
        assert.match(status, /test jobs$/, `a daily load reports a job count, got "${status}"`);
        assert.ok(
            !/^21 days/.test(status),
            'and must not report the 21-day window it was not asked for'
        );

        // The table really rendered from that file.
        const rows = day.document.querySelectorAll('.folder-row');
        assert.ok(rows.length > 0, 'the day renders component rows');
    } finally {
        day.restore();
    }
});

// =========================================================================
// The detailed file: the fetch, the merge, and the three things it unblocks
// =========================================================================

/**
 * A second page on its own module instance, so a test can watch the request
 * log from the first paint.
 *
 * The suite's main harness is shared and by this point has already expanded
 * components, so its log cannot answer "was the detailed file fetched on
 * load". `?tag=` gives the controller a fresh module registry entry and with it
 * a fresh set of module-level flags.
 */
async function freshPage(
    tag: string,
    files: Record<string, unknown> = FILES,
    url = 'https://tests.firefox.dev/issues.html'
): Promise<ReturnType<typeof setupPage>> {
    const page = setupPage({ page: 'issues', url, files });
    const module = await import(`../site/issues.ts?${tag}=${Date.now()}-${Math.random()}`);
    await (module as { start: () => Promise<void> }).start();
    return page;
}

/** A started page's component row by name. */
function componentIn(page: ReturnType<typeof setupPage>, name: string): HTMLElement {
    return [...page.document.querySelectorAll<HTMLElement>('.folder-row')].find(
        (row) => row.querySelector('strong')?.textContent === name
    )!;
}

test('the fetch happens on expansion, once, and never blocks a render', async () => {
    const page = await freshPage('fetch');
    try {
        // On load: not asked for. The 15.9 MB file is not part of opening the
        // page — upstream fetches it only when a component is expanded
        // (`old/issues.html:2330-2332`).
        assert.deepEqual(
            page.requested,
            ['index.json', 'xpcshell-issues.json'],
            'the first paint fetches the index and the 2.8 MB aggregate, and nothing else'
        );
        assert.ok(
            page.document.querySelectorAll('.folder-row').length > 0,
            'and the table is already rendered'
        );

        // On expansion: asked for, and the rows do not wait for it.
        page.hold('xpcshell-issues-with-taskids.json');
        componentIn(page, 'Core :: Networking').click();

        // Synchronously after the click, with the response still held. A page
        // that awaited the merge before rendering would have no rows here,
        // which is the only way to ask "does the merge block the render".
        const paths = [...page.document.querySelectorAll<HTMLElement>('.test-row')].map(
            (row) => row.dataset['path']
        );
        assert.ok(paths.includes(FAIL_TEST), `the test rows are in already, got ${paths}`);
        assert.deepEqual(page.requested.slice(2), ['xpcshell-issues-with-taskids.json']);

        page.release('xpcshell-issues-with-taskids.json');
        await page.window.__detailedLoad?.();
        assert.equal(
            (page.window.__view?.() as { detailedLoaded: boolean }).detailedLoaded,
            true
        );

        // And once merged, expanding more components asks for nothing further.
        // 15.9 MB is not a request to make twice; `old/issues.html:3408` guards it
        // with two flags and this asserts the guard from outside.
        const before = page.requested.length;
        for (const row of [...page.document.querySelectorAll<HTMLElement>('.folder-row')]) {
            if (!row.classList.contains('expanded')) {
                row.click();
            }
        }
        await page.window.__detailedLoad?.();
        assert.deepEqual(page.requested.slice(before), [], 'no second fetch');
    } finally {
        page.restore();
    }
});

test('the merge moves no number on the page', async () => {
    // The property that makes the merge safe to do behind the reader's back.
    // Rendered cells before and after, compared as strings — not the decoded
    // totals, which are what the merge replaces.
    const fresh = await freshPage('merge');
    try {
        const read = (): string[] =>
            [...fresh.document.querySelectorAll('.folder-row')].map((row) =>
                [...row.querySelectorAll('.stat-value')]
                    .map((cell) => cell.textContent)
                    .join('|')
            );

        const before = read();
        assert.ok(before.length > 1 && before[0]!.includes('|'), 'rows were rendered');

        // Force the merge, then re-render by toggling a checkbox off and on.
        const row = [...fresh.document.querySelectorAll<HTMLElement>('.folder-row')][0]!;
        row.click();
        await fresh.window.__detailedLoad?.();
        assert.equal(
            (fresh.window.__view?.() as { detailedLoaded: boolean }).detailedLoaded,
            true,
            'the merge landed'
        );
        const box = fresh.document.getElementById('filter-skips') as HTMLInputElement;
        box.checked = false;
        box.dispatchEvent(new fresh.window.Event('change'));
        box.checked = true;
        box.dispatchEvent(new fresh.window.Event('change'));

        assert.deepEqual(read(), before, 'every rendered stat cell is unchanged by the merge');
    } finally {
        fresh.restore();
    }
});

test('clicking a failure message lists its runs, once the detailed file is in', async () => {
    // The user-visible half of the regression: before the merge this said
    // "No matching runs found", and the migration made that the permanent
    // state by never fetching the file.
    const page = await freshPage('runs');
    try {
        page.hold('xpcshell-issues-with-taskids.json');
        componentIn(page, 'Core :: Networking').click();
        const testRow = [...page.document.querySelectorAll<HTMLElement>('.test-row')].find(
            (row) => row.dataset['path'] === FAIL_TEST
        )!;
        testRow.click();

        const lineFor = (message: string): HTMLElement =>
            [...page.document.querySelectorAll<HTMLElement>('.issue-item')].find(
                (item) => item.dataset['issueMessage'] === message
            )!;

        // Before the merge: the line is there with its real count, and opening
        // it says so rather than showing an empty table.
        const line = lineFor(SPLIT_MESSAGE);
        const expected = handFailures(FAIL_TEST_ID).get(SPLIT_MESSAGE)!;
        assert.equal(line.querySelector('.issue-count')?.textContent, String(expected.total));
        line.click();
        const runs = (): HTMLElement => line.nextElementSibling!.nextElementSibling as HTMLElement;
        assert.equal(
            runs().textContent,
            'No matching runs found',
            'the counts-only file cannot attribute a run, and the page says so'
        );
        line.click();

        // After it: real rows, one per run, in the fixture's own job names.
        page.release('xpcshell-issues-with-taskids.json');
        await page.window.__detailedLoad?.();

        // Reopening the test rebuilds the list against the merged file.
        testRow.click();
        testRow.click();
        const merged = lineFor(SPLIT_MESSAGE);
        merged.click();
        const rows = [
            ...(merged.nextElementSibling!.nextElementSibling as HTMLElement).querySelectorAll(
                'tr'
            ),
        ];
        assert.equal(
            rows.length,
            expected.total,
            `one row per run: expected ${expected.total}, got ${rows.length}`
        );

        // The job names are the fixture's, not a placeholder — the assertion
        // that would fail if the merge landed but the task table did not.
        const shown = rows.map((row) => row.querySelector('.run-job-name')?.textContent ?? '');
        assert.ok(
            shown.every((name) => name.length > 0),
            `every row names a job, got ${JSON.stringify(shown)}`
        );
        const known = new Set(handJobNames(FAIL_TEST_ID, 'FAIL'));
        for (const name of shown) {
            assert.ok(known.has(name), `"${name}" is not a job name in the fixture`);
        }

        // The dates are the days the fixture recorded, newest first, and
        // printed only on the first row of a day (`common-ui.js:488`).
        const dates = rows.map((row) => row.querySelector('.run-date')?.textContent ?? '');
        const expectedDays = [...expected.byDay.entries()].sort((a, b) => b[0] - a[0]);
        const expectedDates: string[] = [];
        for (const [day, count] of expectedDays) {
            for (let i = 0; i < count; i++) {
                expectedDates.push(i === 0 ? handDate(day) : '');
            }
        }
        assert.deepEqual(dates, expectedDates);

        // And every row links out: a profile for each, and a Job link because
        // the fixture carries the commit ids `getTreeherderJobUrl` needs.
        for (const row of rows) {
            const links = [...row.querySelectorAll('.view-links a')].map(
                (link) => link.textContent
            );
            assert.deepEqual(links, ['Profile', 'Job'], 'each run offers a profile and a job');
        }
    } finally {
        page.restore();
    }
});

test('a failure message with no detailed file still lists nothing, and does not throw', async () => {
    // The old page's fallback, which the merge must not have replaced with a
    // crash: `loadDetailedData` warns and carries on (`old/issues.html:3417`).
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => void warnings.push(args);
    // The detailed file is deliberately absent, so `fetchData` 404s.
    const page = await freshPage('nodetail', {
        'index.json': INDEX,
        'xpcshell-issues.json': AGGREGATE,
    });
    try {
        componentIn(page, 'Core :: Networking').click();
        await page.window.__detailedLoad?.();

        assert.ok(
            page.requested.includes('xpcshell-issues-with-taskids.json'),
            'it was asked for'
        );
        assert.deepEqual(
            warnings.map((args) => args[0]),
            ['Detailed data not available'],
            'and the failure was a warning, not an error'
        );

        // The page is intact: the rows rendered, the numbers are the
        // aggregate's, and clicking through to a run list is not a crash.
        assert.equal(
            (page.window.__view?.() as { detailedLoaded: boolean }).detailedLoaded,
            false
        );
        const testRow = [...page.document.querySelectorAll<HTMLElement>('.test-row')].find(
            (row) => row.dataset['path'] === FAIL_TEST
        )!;
        testRow.click();
        const line = [...page.document.querySelectorAll<HTMLElement>('.issue-item')].find(
            (item) => item.dataset['issueMessage'] === SPLIT_MESSAGE
        )!;
        line.click();
        assert.equal(
            (line.nextElementSibling!.nextElementSibling as HTMLElement).textContent,
            'No matching runs found'
        );
    } finally {
        console.warn = realWarn;
        page.restore();
    }
});

// =========================================================================
// The daily-rate charts
// =========================================================================

/**
 * A test's runs bucketed by day and outcome, counted off the raw fixture.
 *
 * The same five buckets `old/issues.html:2380-2388` initialises, filled by the same
 * five-way classification (`:2404-2414`) — note that `EXPECTED-FAIL` matches
 * none of the five and is therefore counted nowhere, which is upstream's
 * behaviour and has to be reproduced here or the denominators disagree.
 */
function handDailyOutcomes(
    testId: number,
    file: { tables: { statuses: string[] }; testRuns: unknown[][]; metadata: { days?: number } }
): { passes: number; failures: number; timeouts: number; crashes: number; skips: number }[] {
    const days = file.metadata.days ?? 21;
    const series = Array.from({ length: days }, () => ({
        passes: 0,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
    }));
    const statuses = file.tables.statuses;
    for (let statusId = 0; statusId < statuses.length; statusId++) {
        const status = statuses[statusId]!;
        const group = file.testRuns[testId]?.[statusId] as
            | { days: number[]; counts?: number[]; taskIdIds?: number[][] }
            | null
            | undefined;
        if (!group) {
            continue;
        }
        let field: keyof (typeof series)[number] | null = null;
        if (status.startsWith('PASS')) {
            field = 'passes';
        } else if (status === 'CRASH') {
            field = 'crashes';
        } else if (status.startsWith('TIMEOUT')) {
            field = 'timeouts';
        } else if (status === 'SKIP') {
            field = 'skips';
        } else if (status.startsWith('FAIL')) {
            field = 'failures';
        }
        if (field === null) {
            continue;
        }
        let day = 0;
        for (let i = 0; i < group.days.length; i++) {
            day += group.days[i]!;
            if (day >= days) {
                continue;
            }
            series[day]![field] += group.counts?.[i] ?? group.taskIdIds![i]!.length;
        }
    }
    return series;
}

/** Sums per-test daily outcomes, as a component chart does. */
function handComponentOutcomes(
    testIds: number[],
    file: Parameters<typeof handDailyOutcomes>[1]
): ReturnType<typeof handDailyOutcomes> {
    const days = file.metadata.days ?? 21;
    const out = Array.from({ length: days }, () => ({
        passes: 0,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
    }));
    for (const testId of testIds) {
        const one = handDailyOutcomes(testId, file);
        for (let day = 0; day < days; day++) {
            out[day]!.passes += one[day]!.passes;
            out[day]!.failures += one[day]!.failures;
            out[day]!.timeouts += one[day]!.timeouts;
            out[day]!.crashes += one[day]!.crashes;
            out[day]!.skips += one[day]!.skips;
        }
    }
    return out;
}

/** A recorded chart's dataset by its label, or `undefined`. */
function seriesOf(
    call: { datasets: { label: string; data: number[] }[] },
    label: string
): number[] | undefined {
    return call.datasets.find((dataset) => dataset.label === label)?.data;
}

test('expanding a component draws its two charts, from its listed tests', async () => {
    const page = await freshPage('componentchart');
    try {
        componentIn(page, 'Core :: Networking').click();
        await page.window.__detailedLoad?.();

        // Both canvases exist in the document, before the test rows, and the
        // charts were made against them while they were attached — a detached
        // canvas is Chart.js's silent no-op and the reason the old page draws
        // in a second pass.
        const slot = page.document.querySelector('.historical-chart')!;
        const canvases = [...slot.querySelectorAll('canvas')].map((canvas) => canvas.id);
        assert.deepEqual(canvases, [
            'component-chart-Core----Networking-canvas',
            'component-chart-Core----Networking-skips-canvas',
        ]);
        for (const call of page.chartJs) {
            assert.equal(call.attached, true, `${call.canvasId} was drawn while detached`);
        }

        // The chart covers the tests the component *listed*, which is
        // `group.tests` — those with an issue (`old/issues.html:2192`, `:2016`) —
        // and not the component's whole population. The two differ here, which
        // is what makes the choice observable.
        const listedIds = [...page.document.querySelectorAll<HTMLElement>('.test-row')].map(
            (row) => pathToTestId(row.dataset['path']!)
        );
        assert.deepEqual(
            listedIds.map((id) => testPathOf(id)),
            [FAIL_TEST, 'netwerk/test/unit/test_socks.js'],
            'both of Core :: Networking\'s tests have an issue and are listed'
        );
        const expected = handComponentOutcomes(listedIds, DETAILED);
        // A one-test chart would be a different series, so "did it use the
        // listed set" is a question this data can answer.
        assert.notDeepEqual(expected, handComponentOutcomes([FAIL_TEST_ID], DETAILED));

        const main = page.chartJs.find(
            (call) => call.canvasId === 'component-chart-Core----Networking-canvas'
        )!;
        assert.equal(main.type, 'bar');
        assert.deepEqual(
            main.labels,
            expected.map((_, day) => handDate(day)),
            'one labelled bar per day of the window'
        );

        // The three stacked series, each over the runs that executed — passes
        // plus the three non-skip outcomes (`old/issues.html:2819-2823`).
        const executed = expected.map(
            (day) => day.passes + day.failures + day.timeouts + day.crashes
        );
        const rate = (count: number, total: number): number =>
            total > 0 ? (count / total) * 100 : 0;
        assert.deepEqual(
            seriesOf(main, 'Failure %'),
            expected.map((day, i) => rate(day.failures, executed[i]!))
        );
        assert.deepEqual(
            seriesOf(main, 'Timeout %'),
            expected.map((day, i) => rate(day.timeouts, executed[i]!))
        );
        assert.deepEqual(
            seriesOf(main, 'Crash %'),
            expected.map((day, i) => rate(day.crashes, executed[i]!))
        );
        assert.ok(
            seriesOf(main, 'Failure %')!.some((value) => value > 0),
            'and the failure series is not all zeroes, or this asserts nothing'
        );

        // The skips chart's denominator is different, and deliberately so: a
        // skip rate is over *scheduled* runs (`:2824`).
        const skipChart = page.chartJs.find(
            (call) => call.canvasId === 'component-chart-Core----Networking-skips-canvas'
        )!;
        assert.deepEqual(
            seriesOf(skipChart, 'Skip %'),
            expected.map((day, i) => rate(day.skips, executed[i]! + day.skips))
        );
        assert.ok(
            seriesOf(skipChart, 'Skip %')!.some((value) => value > 0),
            'and the skip series is not all zeroes'
        );
        // The two denominators really do differ on this data, so the test
        // above could not pass with the wrong one.
        assert.notDeepEqual(
            seriesOf(skipChart, 'Skip %'),
            expected.map((day, i) => rate(day.skips, executed[i]!))
        );

        // With both charts shown the lower one drops its x-axis (`:2909-2913`).
        const skipCanvas = page.document.getElementById(
            'component-chart-Core----Networking-skips-canvas'
        )!;
        assert.ok(skipCanvas.classList.contains('no-x-axis'));
        assert.equal(
            (
                (skipChart.options['scales'] as { x: { display?: boolean } }).x as {
                    display?: boolean;
                }
            ).display,
            false
        );
    } finally {
        page.restore();
    }
});

test('expanding a test draws its own chart, over that test alone', async () => {
    const page = await freshPage('testchart');
    try {
        componentIn(page, 'Core :: Networking').click();
        await page.window.__detailedLoad?.();
        const before = page.chartJs.length;

        const row = [...page.document.querySelectorAll<HTMLElement>('.test-row')].find(
            (candidate) => candidate.dataset['path'] === FAIL_TEST
        )!;
        row.click();

        const drawn = page.chartJs.slice(before);
        const main = drawn.find((call) => call.canvasId === `test-chart-${FAIL_TEST_ID}-canvas`)!;
        assert.ok(main !== undefined, `no test chart; drew ${drawn.map((c) => c.canvasId)}`);
        assert.equal(main.attached, true);

        const expected = handDailyOutcomes(FAIL_TEST_ID, DETAILED);
        const executed = expected.map(
            (day) => day.passes + day.failures + day.timeouts + day.crashes
        );
        assert.deepEqual(
            seriesOf(main, 'Failure %'),
            expected.map((day, i) => (executed[i]! > 0 ? (day.failures / executed[i]!) * 100 : 0))
        );

        // The chart slot precedes the issue list inside the details row, which
        // is where `old/issues.html:2956-2962` puts it.
        const details = row.nextElementSibling!;
        const content = details.querySelector('.issue-details-content')!;
        assert.equal(content.firstElementChild?.className, 'historical-chart');
    } finally {
        page.restore();
    }
});

test('a failure message charts every status it was recorded under', async () => {
    // Divergence 6, asserted as a number rather than as prose. Upstream stops
    // at the first matching status id and charts `FAIL-PARALLEL` alone; this
    // message is under `FAIL-PARALLEL` **and** `FAIL-SEQUENTIAL`, so the two
    // answers differ and the test can tell them apart.
    const page = await freshPage('messagechart');
    try {
        componentIn(page, 'Core :: Networking').click();
        await page.window.__detailedLoad?.();
        const row = [...page.document.querySelectorAll<HTMLElement>('.test-row')].find(
            (candidate) => candidate.dataset['path'] === FAIL_TEST
        )!;
        row.click();
        const line = [...page.document.querySelectorAll<HTMLElement>('.issue-item')].find(
            (item) => item.dataset['issueMessage'] === SPLIT_MESSAGE
        )!;

        const before = page.chartJs.length;
        line.click();
        const call = page.chartJs.slice(before)[0];
        assert.ok(call !== undefined, 'clicking the line drew a chart');
        assert.equal(call.attached, true);

        const expected = handFailures(FAIL_TEST_ID).get(SPLIT_MESSAGE)!;
        assert.deepEqual(
            [...expected.statuses].sort(),
            ['FAIL-PARALLEL', 'FAIL-SEQUENTIAL'],
            'the fixture still splits this message across two statuses'
        );

        // The bars are `count / totalRuns * 100` per day, where `totalRuns` is
        // every non-skip run of the test that day (`old/issues.html:2534-2570`).
        const outcomes = handDailyOutcomes(FAIL_TEST_ID, DETAILED);
        const expectedFailRuns = DETAILED.testRuns[FAIL_TEST_ID]!;
        // `EXPECTED-FAIL` is in this denominator and in no other on the page,
        // because upstream's denominator walk classifies nothing.
        const expectedFailByDay = new Array(21).fill(0) as number[];
        for (let statusId = 0; statusId < DETAILED.tables.statuses.length; statusId++) {
            if (DETAILED.tables.statuses[statusId] !== 'EXPECTED-FAIL') {
                continue;
            }
            const group = expectedFailRuns[statusId] as
                | { days: number[]; taskIdIds?: number[][]; counts?: number[] }
                | null
                | undefined;
            if (!group) {
                continue;
            }
            let day = 0;
            for (let i = 0; i < group.days.length; i++) {
                day += group.days[i]!;
                expectedFailByDay[day]! += group.counts?.[i] ?? group.taskIdIds![i]!.length;
            }
        }
        const totals = outcomes.map(
            (day, i) =>
                day.passes + day.failures + day.timeouts + day.crashes + expectedFailByDay[i]!
        );
        const counts = outcomes.map((_, day) => expected.byDay.get(day) ?? 0);
        assert.deepEqual(
            seriesOf(call, 'Occurrence Rate'),
            counts.map((count, i) => (totals[i]! > 0 ? (count / totals[i]!) * 100 : 0))
        );

        // The bars sum to the count printed on the line, which is the whole
        // point: an upstream-faithful chart would sum to less.
        const charted = counts.reduce((sum, count) => sum + count, 0);
        assert.equal(charted, expected.total);
        assert.equal(line.querySelector('.issue-count')?.textContent, String(expected.total));

        // And the number upstream would have produced is genuinely different,
        // so this assertion is not satisfied by both implementations.
        let firstStatusOnly = 0;
        for (const status of DETAILED.tables.statuses) {
            if (status.startsWith('FAIL')) {
                const statusId = DETAILED.tables.statuses.indexOf(status);
                const group = DETAILED.testRuns[FAIL_TEST_ID]![statusId] as {
                    messageIds?: (number | null)[];
                    taskIdIds: number[][];
                };
                for (let i = 0; i < group.taskIdIds.length; i++) {
                    const messageId = group.messageIds?.[i];
                    if (
                        messageId !== null &&
                        messageId !== undefined &&
                        DETAILED.tables.messages[messageId] === SPLIT_MESSAGE
                    ) {
                        firstStatusOnly += group.taskIdIds[i]!.length;
                    }
                }
                break;
            }
        }
        assert.notEqual(
            firstStatusOnly,
            charted,
            'upstream and this page would chart the same number, so divergence 6 is untested'
        );
    } finally {
        page.restore();
    }
});

// =========================================================================
// The platform tooltips
// =========================================================================

test('hovering a Failures cell names the platforms, once the detailed file is in', async () => {
    const page = await freshPage('tooltip');
    try {
        page.hold('xpcshell-issues-with-taskids.json');
        componentIn(page, 'Core :: Networking').click();

        const row = [...page.document.querySelectorAll<HTMLElement>('.test-row')].find(
            (candidate) => candidate.dataset['path'] === FAIL_TEST
        )!;
        const cellFor = (label: string): HTMLElement =>
            [...row.querySelectorAll<HTMLElement>('.stat-item')].find(
                (item) => item.querySelector('.stat-label')?.textContent === label
            )!;
        const failCell = cellFor('Failures');
        const hover = (cell: HTMLElement): void =>
            void cell.dispatchEvent(new page.window.Event('mouseenter'));
        const tooltip = (): Element | null => page.document.querySelector('.dynamic-tooltip');

        // The cell says it is hoverable, because its count is non-zero.
        assert.ok(failCell.classList.contains('lazy-tooltip'));
        assert.equal(failCell.dataset['tooltipType'], 'failures');
        // A zero cell is not, and neither is a component header's cell.
        assert.ok(!cellFor('Crashes').classList.contains('lazy-tooltip'));
        const header = componentIn(page, 'Core :: Networking');
        assert.ok(
            ![...header.querySelectorAll('.stat-item')].some((item) =>
                item.classList.contains('lazy-tooltip')
            ),
            'only test rows are hoverable, as old/issues.html:824-833 has it'
        );

        // Before the merge the aggregate attributes no run to a job, so there
        // is nothing to break down and no box is shown — which is upstream's
        // "empty content means no tooltip" (`:2249`), not a blank box.
        hover(failCell);
        assert.equal(tooltip(), null, 'no tooltip while the counts-only file is all there is');

        page.release('xpcshell-issues-with-taskids.json');
        await page.window.__detailedLoad?.();

        // After it, without a re-render: the same cell now has a breakdown.
        hover(failCell);
        const box = tooltip();
        assert.ok(box !== null, 'the merged file gives the cell something to show');

        // Against the fixture's own job names, run through `shared.js`'s
        // `extractPlatform` — the real one, so the expected platform names are
        // not a list this test invented.
        const platforms = new Map<string, number>();
        for (const jobName of handJobNames(FAIL_TEST_ID, 'FAIL')) {
            const platform =
                (page.window as unknown as { extractPlatform(name: string): string })
                    .extractPlatform(jobName) || 'unknown';
            platforms.set(platform, (platforms.get(platform) ?? 0) + 1);
        }
        const ranked = [...platforms].sort((a, b) => b[1] - a[1]);
        const total = ranked.reduce((sum, [, count]) => sum + count, 0);

        assert.equal(box!.querySelector('strong')?.textContent, 'Failures by Platform:');
        const lines = [...box!.querySelectorAll('.tooltip-platform')].map((line) => [
            line.querySelector('.tooltip-platform-name')?.textContent,
            line.lastElementChild?.textContent,
        ]);
        assert.deepEqual(
            lines,
            ranked.map(([platform, count]) => [
                `${platform}:`,
                `${count} (${((count / total) * 100).toFixed(1)}%)`,
            ])
        );
        assert.ok(lines.length > 0, 'and there is at least one platform line');

        // The shares are over the platforms shown, so they add to 100%.
        const shares = lines.map((line) =>
            Number(/\(([\d.]+)%\)/.exec(line[1] ?? '')?.[1] ?? '0')
        );
        assert.ok(
            Math.abs(shares.reduce((sum, share) => sum + share, 0) - 100) < 0.15,
            `shares ${shares} do not add to 100`
        );

        // Leaving takes it away again.
        failCell.dispatchEvent(new page.window.Event('mouseleave'));
        assert.equal(tooltip(), null);
    } finally {
        page.restore();
    }
});
